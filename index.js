// SPDX-License-Identifier: CC-BY-NC-4.0
// © 2026 wangzhen110 · https://github.com/wangzhen110/dsh-omni-memory
// NonCommercial use only; attribution required. See LICENSE and ATTRIBUTION.md.
/**
 * Omni memory — host half.
 *
 * Design borrows the strongest idea from each existing system:
 *  - Anthropic: transcripts stay raw; notes are a separate, small, curated layer.
 *  - Zep/Graphiti: facts are bi-temporal. Contradiction invalidates, never deletes.
 *  - HippoRAG: entities and edges make associative recall possible.
 *  - solopup-memory: every note keeps a source pointer and a revision counter.
 *  - dsh-memento: forgetting is a tombstone, so history stays auditable.
 *
 * Retrieval fuses a lexical route (FTS5 trigram) with a vector route (hashed
 * character n-grams) using reciprocal rank fusion, the same shape Hindsight
 * uses. Nothing here touches an Agent, a Session projection, or the chat render
 * tree: preparing a live Session would blank the conversation, so this plugin
 * only reads/writes its own SQLite file.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DIM, embedText, dot, toBlob, fromBlob, tokenize } from './lib/embed.mjs';
import { backendConfig, embedRemote } from './lib/embed-provider.mjs';

const DSH_HOME = process.env.DSH_HOME || path.join(homedir(), '.dsh');
const DB_DIR = path.join(DSH_HOME, 'memory');
const DB_FILE = path.join(DB_DIR, 'omni.db');
const PROFILE_BUDGET = 1200;
const PROFILE_CACHE_MS = 30_000;
const MAX_CAPTURE_CHARS = 4000;

let store;

/**
 * Scope layers.
 *
 * `global`  — cross-project rules and preferences; injected everywhere.
 * `proj:x`  — one workspace; recalled and injected only inside that workspace.
 *
 * The workspace is derived from `session.header.cwd`, so a conversation in a
 * project directory writes project-scoped transcripts and sees project notes,
 * while a conversation elsewhere sees only the global layer.
 */
const SCOPE_GLOBAL = 'global';
const cwdBySession = new Map();
const projectByAgent = new Map();
let lastClaimAt = 0;
const MAX_PENDING_VECTORS = 4096;
const REMOTE_PROBE_TEXT = 'omni-memory embedding dimension probe';

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function projectKeyFromCwd(cwd) {
  const raw = String(cwd ?? '').trim();
  if (!raw) return SCOPE_GLOBAL;
  const normalized = raw.replaceAll('\\', '/').replace(/\/+$/, '') || raw;
  const base = normalized.split('/').pop() ?? normalized;
  const safe = base.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `proj:${safe || 'project'}#${fnv1a(normalized).toString(16).slice(0, 6)}`;
}

const WORKSPACES_DIR = path.join(DSH_HOME, 'sessions');

/**
 * DSH names a workspace folder after its path: ASCII stays, and other code
 * units become '~XXXX'. Separators and literals are both '-', so the decode is
 * only good enough for a human-readable label — never for identity.
 */
function workspaceLabelFromDirName(name) {
  const text = String(name ?? '');
  if (!text.startsWith('--') || !text.endsWith('--') || text.length < 6) return '';
  const decoded = text
    .slice(2, -2)
    .replace(/~([0-9a-fA-F]{4,6})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  const marker = /-(?:Desktop|Documents|Downloads|src|projects|code)-/i.exec(decoded);
  const tail = marker ? decoded.slice(marker.index + marker[0].length) : decoded;
  return tail
    .replace(/^项目-/, '')
    .replace(/^-+|-+$/g, '')
    .trim();
}

/** Compare labels ignoring the separators the folder name collapses. */
function normalizeWorkspaceLabel(value) {
  return String(value ?? '').toLowerCase().replace(/[\s_-]+/g, '');
}

let workspaceCache = { at: 0, list: [] };
const WORKSPACE_CACHE_MS = 60_000;

/** Workspaces DSH knows about, whether or not they hold any memories. */
function discoverWorkspaces() {
  if (Date.now() - workspaceCache.at < WORKSPACE_CACHE_MS) return workspaceCache.list;
  const list = [];
  try {
    for (const entry of readdirSync(WORKSPACES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // Temp probes and the internal IM workspace are not user projects.
      if (/AppData-Local-Temp|acp-probe|\.dsh-im/i.test(entry.name)) continue;
      const label = workspaceLabelFromDirName(entry.name);
      if (!label) continue;
      list.push({ dir: entry.name, label, normalized: normalizeWorkspaceLabel(label) });
    }
  } catch { /* no session folder yet: show what the database has */ }
  workspaceCache = { at: Date.now(), list };
  return list;
}

/**
 * Layer judgement at write time.
 *
 * Explicit `scope` always wins. Otherwise the wording decides: artifacts that
 * only make sense in one workspace go to the project layer, cross-project rules
 * and preferences go to the global layer, and an ambiguous statement stays in
 * the project it was said in (the cheaper error: a rule that needs promoting is
 * easy to find later, whereas a leaked project detail is not).
 */
const GLOBAL_HINTS = [
  '偏好', '习惯', '以后', '总是', '永远', '一律', '所有项目', '跨项目', '通用',
  '铁律', '禁止', '不要再', '宁可不',
];
const PROJECT_HINTS = [
  '本项目', '这个项目', '当前项目', '本仓库', '本工程', '这个插件', '本插件',
  'src/', 'docs/', 'package.json', '.mjs', '.ts', '.js', '构建', '部署', '迁移', '表结构', '字段',
];

function classifyScope(text, project) {
  const value = String(text ?? '');
  const globalScore = GLOBAL_HINTS.filter(hint => value.includes(hint)).length;
  const projectScore = PROJECT_HINTS.filter(hint => value.includes(hint)).length;
  if (!project) return { scope: SCOPE_GLOBAL, reason: 'no-project', confidence: 1 };
  if (globalScore > 0 && projectScore === 0) {
    return { scope: SCOPE_GLOBAL, reason: 'cross-project wording', confidence: 0.8 };
  }
  if (projectScore > 0) return { scope: project, reason: 'project-specific wording', confidence: 0.85 };
  return { scope: project, reason: 'default-to-project', confidence: 0.55 };
}

function decideScope(explicit, text, project = currentProject()) {
  const given = String(explicit ?? '').trim();
  if (given === 'all') throw new Error('scope=all is read-only; choose global or a project scope');
  if (given) return { scope: given === SCOPE_GLOBAL ? SCOPE_GLOBAL : given, reason: 'explicit', confidence: 1 };
  return classifyScope(text, project);
}

/**
 * Model-based layer judgement.
 *
 * Rules are cheap but keyword-blind; the host `llm` service can do better. Writes
 * never wait for it: the row lands immediately under the rule's verdict and a
 * background call re-checks ambiguous cases, moving the row when the model
 * disagrees. Mode: OMNI_SCOPE_JUDGE=off|auto|always (default off = no upload).
 */
const judgeQueue = [];
const MAX_JUDGE_QUEUE = 256;
let judgeBusy = false;
let lastJudge = null;

function judgeMode() {
  // Default is `off`: memory writes must not upload their body to a model
  // unless the user explicitly opts in with OMNI_SCOPE_JUDGE=auto|always.
  return String(process.env.OMNI_SCOPE_JUDGE ?? 'off');
}

async function pickJudgeRoute(llm) {
  const provider = process.env.OMNI_JUDGE_PROVIDER || (llm.listProviders?.() ?? [])[0]?.id;
  if (!provider) return null;
  if (process.env.OMNI_JUDGE_MODEL) return { provider, model: process.env.OMNI_JUDGE_MODEL };
  const models = (await llm.listModels?.(provider)) ?? [];
  const cheap = models.find(model => /flash|mini|haiku|small|lite/i.test(String(model.id))) ?? models[0];
  return cheap ? { provider, model: cheap.id } : null;
}

function enqueueJudge(ctx, item) {
  const mode = judgeMode();
  if (mode === 'off') return;
  // Explicit scope is the caller's decision; the model must not overrule it.
  if (item.reason === 'explicit') return;
  // Without a project there is no layer choice to make.
  if (!item.project) return;
  if (mode === 'auto' && Number(item.confidence ?? 0) >= 0.8) return;
  // Never grow an unbounded queue when the host has no llm service or the
  // user is offline. A dropped job keeps the rule verdict, which is safe.
  if (judgeQueue.length >= MAX_JUDGE_QUEUE) return;
  if (!ctx || typeof ctx.get !== 'function' || !ctx.get('llm')) return;
  judgeQueue.push(item);
  void flushJudge(ctx);
}

async function flushJudge(ctx) {
  if (judgeBusy) return;
  judgeBusy = true;
  try {
    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined;
    if (!llm || typeof llm.stream !== 'function') return;
    const route = await pickJudgeRoute(llm);
    if (!route) return;
    while (judgeQueue.length) {
      const item = judgeQueue.shift();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        let out = '';
        const stream = llm.stream({
          provider: route.provider,
          model: route.model,
          system: 'Classify one memory as global (a rule that applies across projects) or project (meaningful only inside one workspace). Answer with exactly one word.',
          messages: [{
            role: 'user',
            content: [{ type: 'text', text: `workspace: ${item.project ?? 'none'}\nmemory: ${item.text}\nanswer:` }],
          }],
          maxTokens: 8,
          temperature: 0,
          signal: controller.signal,
        });
        for await (const chunk of stream) {
          if (chunk?.type === 'text-delta') out += chunk.text ?? '';
          else if (chunk?.type === 'finish') break;
        }
        clearTimeout(timer);
        // An empty answer is not "global". It is a failed judgement: keep the
        // rule's verdict rather than silently promoting a project note.
        const answer = out.trim();
        const verdict = answer ? (/(?:project|项目)/i.test(answer) ? (item.project ?? SCOPE_GLOBAL) : SCOPE_GLOBAL) : item.scope;
        const moved = verdict !== item.scope;
        if (moved) {
          const s = openStore();
          s.db.prepare(`UPDATE ${item.table} SET scope = ? WHERE id = ?`).run(verdict, Number(item.id));
          invalidateProfile();
        }
        lastJudge = {
          at: now(), kind: item.kind, id: Number(item.id),
          from: item.scope, to: verdict, moved,
          model: `${route.provider}/${route.model}`,
        };
      } catch { /* keep the rule's verdict */ }
    }
  } catch { /* judging must never break a write */ } finally {
    judgeBusy = false;
  }
}

function currentProject(context = null) {
  const raw = context?.agent?.id ?? context?.session?.id ?? context?.scope?.id ?? context?.scope ?? '';
  const id = String(raw ?? '').trim();
  if (!id) return null;
  return projectForScope({ id });
}

/**
 * Auto-recall state.
 *
 * `AssembleContext` exposes only `scope` and `signal`, so the prompt section
 * cannot read the incoming user message. The message is captured from the
 * inbox-claimed event and recall is precomputed asynchronously; the synchronous
 * section provider then reads the cached result. A missed race degrades to
 * profile-only injection, never to an error.
 */
const AUTO_RECALL_TTL_MS = 120_000;
const lastUserByAgent = new Map();
const recallByAgent = new Map();
let lastInjection = { at: 0, chars: 0, recall: 0, auto: false };

function autoRecallEnabled() {
  // Switch: OMNI_AUTO_RECALL=0 disables; anything else (including unset) enables.
  return process.env.OMNI_AUTO_RECALL !== '0';
}

function now() {
  return Date.now();
}

function hash(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 32);
}

function openStore() {
  if (store) return store;
  mkdirSync(DB_DIR, { recursive: true });
  const db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      session_id TEXT,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      hash TEXT NOT NULL,
      source TEXT,
      importance REAL NOT NULL DEFAULT 0.5,
      deleted_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      scope TEXT NOT NULL DEFAULT 'global',
      text TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      source TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      superseded_by INTEGER,
      contested INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT NOT NULL,
      relation TEXT NOT NULL,
      object TEXT NOT NULL,
      text TEXT NOT NULL,
      valid_from INTEGER NOT NULL,
      valid_to INTEGER,
      recorded_at INTEGER,
      confidence REAL NOT NULL DEFAULT 0.7,
      source TEXT,
      contested INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      kind TEXT
    );

    CREATE TABLE IF NOT EXISTS edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      src TEXT NOT NULL,
      rel TEXT NOT NULL,
      dst TEXT NOT NULL,
      valid_from INTEGER NOT NULL,
      valid_to INTEGER,
      scope TEXT,
      source TEXT
    );

    CREATE TABLE IF NOT EXISTS bigrams (
      layer TEXT NOT NULL,
      owner_id INTEGER NOT NULL,
      gram TEXT NOT NULL,
      PRIMARY KEY (layer, owner_id, gram)
    );
    CREATE INDEX IF NOT EXISTS bigrams_gram ON bigrams(gram, layer, owner_id);
  `);

  // Trigram tokenisation is what makes CJK substring recall work; fall back to
  // the default tokenizer when the bundled SQLite lacks it.
  let ftsMode = 'like';
  const createFts = (table) => {
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING fts5(text, tokenize='trigram')`);
      return 'trigram';
    } catch {
      try {
        db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING fts5(text)`);
        return 'unicode61';
      } catch {
        return null;
      }
    }
  };
  const chunksMode = createFts('chunks_fts');
  const notesMode = createFts('notes_fts');
  const factsMode = createFts('facts_fts');
  ftsMode = chunksMode ?? notesMode ?? factsMode ?? 'like';

  // Schema migrations. A fresh database and an upgraded one must converge on the
  // same structure, so every structural change is a numbered migration.
  const schemaVersion = migrate(db);
  if (notesMode) backfillFts(db, 'notes_fts', 'notes');
  if (factsMode) backfillFts(db, 'facts_fts', 'facts');
  backfillBigrams(db);
  restoreRemoteState(db);
  backfillVectors(db);

  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('fts_mode', ftsMode);
  store = {
    db,
    ftsMode,
    schemaVersion,
    fts: { chunks: Boolean(chunksMode), notes: Boolean(notesMode), facts: Boolean(factsMode) },
  };
  return store;
}

export const SCHEMA_VERSION = 7;

function columnExists(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
  } catch {
    return false;
  }
}

function addColumn(db, table, column, type) {
  if (columnExists(db, table, column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  return true;
}

/**
 * Ordered migrations. Index = target version. Never edit a shipped step; append
 * a new one instead so existing databases replay the same history.
 */
const MIGRATIONS = [
  null,
  // v1: baseline schema is created by CREATE TABLE IF NOT EXISTS above.
  () => {},
  // v2: per-layer scope columns so a project filter covers facts and transcripts.
  db => {
    addColumn(db, 'facts', 'scope', 'TEXT');
    addColumn(db, 'chunks', 'scope', 'TEXT');
  },
  // v3: vector index for the vector half of hybrid retrieval.
  db => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS vectors (
        kind TEXT NOT NULL,
        owner_id INTEGER NOT NULL,
        dim INTEGER NOT NULL,
        vec BLOB NOT NULL,
        PRIMARY KEY (kind, owner_id)
      );
    `);
  },
  // v4: embedding dimensionality changed (256 → 512). Vectors are a derived
  // index, so the migration drops and rebuilds them from the source rows.
  db => {
    try { db.exec('DELETE FROM vectors'); } catch { /* table may be absent */ }
  },
  // v5: dream verification state — which note was checked against which evidence.
  db => {
    addColumn(db, 'notes', 'verified_at', 'INTEGER');
    addColumn(db, 'notes', 'verification', 'TEXT');
    addColumn(db, 'notes', 'evidence', 'TEXT');
  },
  // v6: legacy manual scopes (`proj:name`, no hash) predate the project layer and
  // were never enforced by the profile. Keeping them would silently hide those
  // rows from every derived project key, so they become global instead — the same
  // visibility they had before the split.
  db => {
    for (const table of ['notes', 'facts', 'chunks']) {
      try {
        db.prepare(`UPDATE ${table} SET scope = 'global' WHERE scope LIKE 'proj:%' AND scope NOT LIKE '%#%'`).run();
      } catch { /* column may be absent on very old databases */ }
    }
  },
  // v7: revision-aware chunks and scoped edges.
  //
  // The old global UNIQUE(hash) index made a compacted chunk impossible to
  // re-capture and made identical text in two projects collide. Deduplicate only
  // among *active* rows in the same scope; tombstoned rows stay as audit history.
  // Edges also need the fact scope, otherwise graph traversal can cross projects
  // even after fact filters were added.
  db => {
    try { db.exec('DROP INDEX IF EXISTS chunks_hash'); } catch { /* absent */ }
    try {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS chunks_hash_active
        ON chunks(hash, IFNULL(scope, 'global'))
        WHERE deleted_at IS NULL
      `);
    } catch { /* best effort; insertChunk still guards duplicates */ }
    db.exec(`
      CREATE TABLE IF NOT EXISTS bigrams (
        layer TEXT NOT NULL,
        owner_id INTEGER NOT NULL,
        gram TEXT NOT NULL,
        PRIMARY KEY (layer, owner_id, gram)
      );
      CREATE INDEX IF NOT EXISTS bigrams_gram ON bigrams(gram, layer, owner_id);
    `);
    addColumn(db, 'edges', 'scope', 'TEXT');
    try {
      db.exec(`
        UPDATE edges
        SET scope = (
          SELECT f.scope FROM facts f
          WHERE f.subject = edges.src AND f.relation = edges.rel AND f.object = edges.dst
          ORDER BY f.valid_from DESC LIMIT 1
        )
        WHERE scope IS NULL
      `);
    } catch { /* legacy rows may not line up; null remains visible as global */ }
    for (const [table, column, type] of [
      ['facts', 'recorded_at', 'INTEGER'],
    ]) {
      addColumn(db, table, column, type);
    }
  },
];

function migrate(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  let version = row ? Number(row.value) : 0;
  if (!Number.isFinite(version) || version < 1) {
    // Unversioned database: treat as v1 and apply the remaining steps.
    version = 1;
  }
  for (let next = version + 1; next <= SCHEMA_VERSION; next += 1) {
    const step = MIGRATIONS[next];
    if (typeof step === 'function') step(db);
  }
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)")
    .run(String(SCHEMA_VERSION));
  return SCHEMA_VERSION;
}

function backfillFts(db, ftsTable, sourceTable) {
  try {
    db.exec(`
      INSERT INTO ${ftsTable}(rowid, text)
      SELECT id, text FROM ${sourceTable}
      WHERE id NOT IN (SELECT rowid FROM ${ftsTable})
    `);
  } catch { /* backfill is best effort */ }
}

const CJK_BIGRAM = /^[\u4e00-\u9fff]{2}$/;

/** Keep the two-character CJK index in sync with one source row. */
function indexBigrams(db, layer, id, text) {
  try {
    const grams = [...new Set(tokenize(text).filter(token => CJK_BIGRAM.test(token)))];
    db.prepare('DELETE FROM bigrams WHERE layer = ? AND owner_id = ?').run(layer, Number(id));
    const insert = db.prepare('INSERT OR IGNORE INTO bigrams(layer, owner_id, gram) VALUES (?, ?, ?)');
    for (const gram of grams) insert.run(layer, Number(id), gram);
  } catch { /* optional index */ }
}

const BIGRAM_BACKFILL_BATCH = 10_000;

function backfillBigrams(db, options = {}) {
  try {
    if (!options.force && metaGet(db, 'bigrams_version') === String(SCHEMA_VERSION)) return;
    const limit = Math.max(1, Number(options.limit ?? BIGRAM_BACKFILL_BATCH));
    let remaining = false;
    for (const [layer, table] of [['note', 'notes'], ['fact', 'facts'], ['chunk', 'chunks']]) {
      const cursorKey = `bigrams_cursor_${layer}`;
      let cursor = options.force ? 0 : Number(metaGet(db, cursorKey) ?? 0);
      if (options.force) metaSet(db, cursorKey, 0);
      const rows = db.prepare(`
        SELECT id, text FROM ${table}
        WHERE deleted_at IS NULL AND id > ?
        ORDER BY id LIMIT ?
      `).all(cursor, limit);
      if (!rows.length) continue;
      for (const row of rows) indexBigrams(db, layer, row.id, row.text);
      cursor = Number(rows[rows.length - 1].id);
      metaSet(db, cursorKey, cursor);
      if (rows.length >= limit) remaining = true;
    }
    if (!remaining) metaSet(db, 'bigrams_version', SCHEMA_VERSION);
  } catch { /* backfill is best effort */ }
}

/**
 * Vector indexing entry point.
 *
 * The hashed backend writes synchronously (microseconds). The remote backend
 * needs the network, so rows are queued and flushed lazily before the next
 * search: writes never block a turn, and retrieval never waits for a batch that
 * a failed request left behind.
 */
const pendingVectors = new Map();
let remoteDim = 0;
let remoteSignatureValue = '';
let remoteProbeFailedAt = 0;
const REMOTE_PROBE_COOLDOWN_MS = 60_000;

function metaGet(db, key) {
  try {
    return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  } catch {
    return null;
  }
}

function metaSet(db, key, value) {
  try {
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(key, String(value));
  } catch { /* meta is best effort */ }
}

function remoteSignature(config = backendConfig()) {
  if (config.kind !== 'remote') return '';
  return hash(`${config.url}\u0000${config.model}`).slice(0, 16);
}

/**
 * Remote dimensions are a property of the endpoint/model, not of the process.
 * Persisting them is what makes a restart keep the vector route alive. A model
 * or URL change starts a new signature; old vectors remain on disk as history
 * but the active dimension is rebuilt from the new backend.
 */
function restoreRemoteState(db) {
  const config = backendConfig();
  if (config.kind !== 'remote') {
    remoteDim = 0;
    remoteSignatureValue = '';
    return;
  }
  const signature = remoteSignature(config);
  const storedSignature = metaGet(db, 'remote_signature');
  const storedDim = Number(metaGet(db, 'remote_dim') ?? 0);
  if (storedSignature === signature && Number.isFinite(storedDim) && storedDim > 0) {
    remoteDim = storedDim;
    remoteSignatureValue = signature;
    return;
  }
  remoteDim = 0;
  remoteSignatureValue = signature;
  metaSet(db, 'remote_signature', signature);
  metaSet(db, 'remote_dim', 0);
}

async function ensureRemoteDim(s) {
  const config = backendConfig();
  if (config.kind !== 'remote') return DIM;
  if (remoteDim > 0) return remoteDim;
  // An unreachable endpoint must not add its timeout to every search: remember
  // the failure and retry the probe after a cooldown while lexical recall answers.
  if (now() - remoteProbeFailedAt < REMOTE_PROBE_COOLDOWN_MS) return 0;
  try {
    const probe = await embedRemote([REMOTE_PROBE_TEXT], config);
    remoteDim = probe[0]?.length ?? 0;
    if (remoteDim > 0) {
      remoteProbeFailedAt = 0;
      remoteSignatureValue = remoteSignature(config);
      metaSet(s.db, 'remote_signature', remoteSignatureValue);
      metaSet(s.db, 'remote_dim', remoteDim);
    } else {
      remoteProbeFailedAt = now();
    }
  } catch {
    remoteProbeFailedAt = now();
  }
  return remoteDim;
}

function enqueueVector(kind, id, text) {
  const key = `${kind}:${id}`;
  if (!pendingVectors.has(key) && pendingVectors.size >= MAX_PENDING_VECTORS) return;
  pendingVectors.set(key, { kind, id: Number(id), text: String(text ?? '') });
}

/** Store (or refresh) one vector for a memory row. */
function upsertVector(s, kind, id, text) {
  indexVector(s, kind, id, text);
}

/**
 * Vector indexing entry point.
 *
 * The hashed backend writes synchronously (microseconds). The remote backend
 * needs the network, so rows are queued and flushed lazily before the next
 * search: writes never block a turn, and retrieval never waits for a batch that
 * a failed request left behind.
 */
function indexVector(s, kind, id, text) {
  const config = backendConfig();
  if (config.kind === 'hashed') {
    try {
      const vector = embedText(text);
      s.db.prepare('INSERT OR REPLACE INTO vectors(kind, owner_id, dim, vec) VALUES (?, ?, ?, ?)')
        .run(kind, Number(id), DIM, toBlob(vector));
    } catch { /* the vector route is optional */ }
    return;
  }
  enqueueVector(kind, id, text);
}

/** Queue a bounded batch of old rows that lack a vector at the active dimension. */
async function backfillRemoteBatch(s) {
  if (backendConfig().kind !== 'remote' || remoteDim <= 0) return;
  for (const [kind, table] of [['note', 'notes'], ['fact', 'facts'], ['chunk', 'chunks']]) {
    try {
      const rows = s.db.prepare(`
        SELECT t.id AS id, t.text AS text
        FROM ${table} t
        WHERE t.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM vectors v
            WHERE v.kind = ? AND v.owner_id = t.id AND v.dim = ?
          )
        ORDER BY t.id
        LIMIT 32
      `).all(kind, remoteDim);
      for (const row of rows) enqueueVector(kind, row.id, row.text);
    } catch { /* backfill is best effort */ }
  }
}

/** Flush queued rows through the remote embedder; never throws. */
async function flushPendingVectors(s) {
  const config = backendConfig();
  if (config.kind !== 'remote') return;
  const dim = await ensureRemoteDim(s);
  if (!dim) return;
  await backfillRemoteBatch(s);
  const entries = [...pendingVectors.values()].slice(0, 32);
  if (!entries.length) return;
  try {
    const vectors = await embedRemote(entries.map(entry => entry.text), config);
    remoteDim = vectors[0].length;
    for (const [index, entry] of entries.entries()) {
      s.db.prepare('INSERT OR REPLACE INTO vectors(kind, owner_id, dim, vec) VALUES (?, ?, ?, ?)')
        .run(entry.kind, entry.id, remoteDim, toBlob(vectors[index]));
      pendingVectors.delete(`${entry.kind}:${entry.id}`);
    }
    metaSet(s.db, 'remote_signature', remoteSignatureValue || remoteSignature(config));
    metaSet(s.db, 'remote_dim', remoteDim);
  } catch { /* keep the queue; lexical recall still answers */ }
}

/** Which vector dimension the active backend produces, or 0 when unknown. */
function activeVectorDim() {
  const config = backendConfig();
  return config.kind === 'hashed' ? DIM : remoteDim;
}

function backfillVectors(db) {
  if (backendConfig().kind !== 'hashed') return; // remote rows are queued on demand
  const jobs = [
    ['note', 'notes', 'text'],
    ['fact', 'facts', 'text'],
    ['chunk', 'chunks', 'text'],
  ];
  for (const [kind, table, column] of jobs) {
    try {
      const rows = db.prepare(`
        SELECT t.id AS id, t.${column} AS text
        FROM ${table} t
        WHERE t.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM vectors v
            WHERE v.kind = ? AND v.owner_id = t.id AND v.dim = ?
          )
      `).all(kind, DIM);
      for (const row of rows) {
        const vector = embedText(row.text);
        db.prepare('INSERT OR REPLACE INTO vectors(kind, owner_id, dim, vec) VALUES (?, ?, ?, ?)')
          .run(kind, Number(row.id), DIM, toBlob(vector));
      }
    } catch { /* index backfill is best effort */ }
  }
}

/** Run a multi-step write atomically. SQLite has no nested transaction here. */
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* ignore rollback failure */ }
    throw error;
  }
}

/** Tombstone one row and keep its derived graph edges consistent. */
function forgetMemory(s, kind, id) {
  const table = { note: 'notes', fact: 'facts', chunk: 'chunks' }[String(kind)];
  if (!table) throw new Error('kind must be note, fact or chunk');
  return transaction(s.db, () => {
    let fact = null;
    if (table === 'facts') {
      fact = s.db.prepare('SELECT subject, relation, object, scope FROM facts WHERE id = ?').get(Number(id));
    }
    const info = s.db.prepare(`UPDATE ${table} SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`)
      .run(now(), Number(id));
    if (fact && Number(info.changes) > 0) {
      s.db.prepare(`
        UPDATE edges SET valid_to = ?
        WHERE src = ? AND rel = ? AND dst = ? AND valid_to IS NULL
          AND (scope = ? OR scope IS NULL)
      `).run(now(), fact.subject, fact.relation, String(fact.object ?? ''), fact.scope ?? SCOPE_GLOBAL);
    }
    return Number(info.changes) > 0;
  });
}

function insertChunk(s, input) {
  const { db, ftsMode } = s;
  const text = String(input.text ?? '').trim();
  if (!text) return null;
  const digest = hash(text);
  const scope = input.scope ?? null;
  const existing = db.prepare(`
    SELECT id FROM chunks
    WHERE hash = ? AND IFNULL(scope, 'global') = IFNULL(?, 'global') AND deleted_at IS NULL
  `).get(digest, scope);
  if (existing) return { id: Number(existing.id), deduped: true };
  return transaction(db, () => {
    const ts = Number(input.ts ?? now());
    const info = db.prepare(
      'INSERT INTO chunks(ts, session_id, role, text, hash, source, importance, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      ts,
      input.sessionId ?? null,
      input.role ?? 'note',
      text,
      digest,
      input.source ?? null,
      Number(input.importance ?? 0.5),
      scope,
    );
    const id = Number(info.lastInsertRowid);
    if (ftsMode !== 'like') {
      try {
        db.prepare('INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)').run(id, text);
      } catch { /* index write is best effort */ }
    }
    indexBigrams(db, 'chunk', id, text);
    upsertVector(s, 'chunk', id, text);
    return { id, deduped: false };
  });
}

function recencyScore(ts) {
  const ageDays = Math.max(0, (now() - Number(ts ?? 0)) / 86_400_000);
  return Math.exp(-ageDays / 120);
}

/**
 * Split a query into matchable terms. CJK has no spaces, and a whole sentence is
 * almost never a contiguous substring, so CJK runs are expanded into character
 * bigrams; latin identifiers stay whole.
 */
function queryTerms(query) {
  const parts = String(query ?? '')
    .toLowerCase()
    .split(/[\s,，。、；：:;\\|()（）“”’!?！？\[\]{}<>]+/u)
    .filter(Boolean);
  const terms = new Set();
  for (const part of parts) {
    if (/[\u4e00-\u9fff]/.test(part) && part.length > 2) {
      for (let i = 0; i + 2 <= part.length; i += 1) terms.add(part.slice(i, i + 2));
      terms.add(part);
    } else {
      terms.add(part);
    }
  }
  return [...terms].slice(0, 12);
}

/** Build `(col LIKE ? OR col LIKE ? ...)` for the supplied columns and terms. */
function likeClause(columns, terms) {
  const parts = [];
  const params = [];
  for (const column of columns) {
    for (const term of terms) {
      parts.push(`IFNULL(${column},'') LIKE ?`);
      params.push(`%${term}%`);
    }
  }
  return { sql: parts.length ? `(${parts.join(' OR ')})` : '1=1', params };
}

/**
 * Scope filter for one column.
 *
 * A project view is a superset: rows of that project plus the global layer (and
 * legacy rows with no scope). `all` disables the filter entirely.
 */
function scopeClause(column, scope, nulls = true) {
  if (!scope || scope === 'all') return { sql: '', params: [] };
  const parts = [`${column} = ?`, `${column} = 'global'`];
  if (nulls) parts.push(`${column} IS NULL`);
  return { sql: `AND (${parts.join(' OR ')})`, params: [scope] };
}

/** Fraction of query terms that appear in the row's text. */
function matchRatio(row, columns, terms) {
  if (!terms.length) return 0;
  const haystack = columns.map(column => String(row[column] ?? '').toLowerCase()).join('\n');
  let hit = 0;
  for (const term of terms) if (haystack.includes(term)) hit += 1;
  return hit / terms.length;
}

function rank(items) {
  return items.sort((a, b) => b.score - a.score);
}

/**
 * Two-character CJK lookup through the bigram index. FTS5 trigram needs three
 * characters, so without this a two-character query degenerated into a full
 * table LIKE scan.
 */
function searchBigrams(s, layer, table, term, limit, filter, extra = '') {
  if (!CJK_BIGRAM.test(term)) return [];
  try {
    return s.db.prepare(`
      SELECT t.* FROM bigrams b
      JOIN ${table} t ON t.id = b.owner_id
      WHERE b.layer = ? AND b.gram = ? AND t.deleted_at IS NULL ${extra} ${filter.sql}
      ORDER BY t.id DESC LIMIT ?
    `).all(layer, term, ...filter.params, limit);
  } catch {
    return [];
  }
}

function searchChunks(s, terms, limit, scope) {
  const { db, ftsMode } = s;
  if (!terms.length) return [];
  const out = [];
  const seen = new Set();
  const push = (row, textScore) => {
    const key = `c${row.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    const ratio = matchRatio(row, ['text', 'source'], terms);
    out.push({
      kind: 'chunk',
      id: Number(row.id),
      ts: Number(row.ts),
      role: row.role,
      source: row.source ?? '',
      scope: row.scope ?? null,
      text: String(row.text).slice(0, 400),
      score: 0.6 * Math.max(textScore, ratio) + 0.2 * Number(row.importance ?? 0.5) + 0.2 * recencyScore(row.ts),
    });
  };

  if (ftsMode !== "like") {
    const filter = scopeClause('c.scope', scope);
    const bigramFilter = scopeClause('t.scope', scope);
    for (const term of terms.slice(0, 5)) {
      if (term.length === 2 && CJK_BIGRAM.test(term)) {
        const rows = searchBigrams(s, 'chunk', 'chunks', term, limit, bigramFilter);
        for (const row of rows) push(row, 1);
        continue;
      }
      if (term.length < 3) continue;
      try {
        const rows = db.prepare(`
          SELECT c.*, bm25(chunks_fts) AS r
          FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
          WHERE chunks_fts MATCH ? AND c.deleted_at IS NULL
          ${filter.sql}
          ORDER BY r LIMIT ?
        `).all(`"${term.replaceAll('"', '""')}"`, ...filter.params, limit);
        for (const row of rows) push(row, 1 / (1 + Math.abs(Number(row.r ?? 1))));
      } catch { /* term not indexable, LIKE covers it */ }
    }
  }

  if (out.length < limit) {
    const clause = likeClause(['text', 'source'], terms);
    const filter = scopeClause('scope', scope);
    const rows = db.prepare(`
      SELECT * FROM chunks
      WHERE deleted_at IS NULL AND ${clause.sql} ${filter.sql}
      ORDER BY importance DESC, ts DESC LIMIT ?
    `).all(...clause.params, ...filter.params, limit);
    for (const row of rows) push(row, 0);
  }
  return out;
}

function searchNotes(s, terms, limit, scope) {
  if (!terms.length) return [];
  const found = new Map();
  const push = (row, textScore) => {
    const id = Number(row.id);
    const candidate = {
      kind: 'note',
      id,
      ts: Number(row.ts),
      scope: row.scope,
      source: row.source ?? '',
      revision: Number(row.revision ?? 1),
      contested: Number(row.contested ?? 0) === 1,
      text: String(row.text).slice(0, 400),
      score: 0.6 * Math.max(0.6, textScore, matchRatio(row, ['text', 'scope'], terms))
        + 0.2 * Number(row.importance ?? 0.5)
        + 0.2 * recencyScore(row.ts),
    };
    const previous = found.get(id);
    if (!previous || candidate.score > previous.score) found.set(id, candidate);
  };

  if (s.fts.notes) {
    const filter = scopeClause('n.scope', scope, false);
    const bigramFilter = scopeClause('t.scope', scope, false);
    for (const term of terms.slice(0, 6)) {
      if (term.length === 2 && CJK_BIGRAM.test(term)) {
        const rows = searchBigrams(s, 'note', 'notes', term, limit, bigramFilter, 'AND t.superseded_by IS NULL');
        for (const row of rows) push(row, 1);
        continue;
      }
      if (term.length < 3) continue;
      try {
        const rows = s.db.prepare(`
          SELECT n.*, bm25(notes_fts) AS r
          FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid
          WHERE notes_fts MATCH ? AND n.deleted_at IS NULL AND n.superseded_by IS NULL
          ${filter.sql}
          ORDER BY r LIMIT ?
        `).all(`"${term.replaceAll('"', '""')}"`, ...filter.params, limit);
        for (const row of rows) push(row, 1 / (1 + Math.abs(Number(row.r ?? 1))));
      } catch { /* term not indexable */ }
    }
  }

  if (found.size < limit) {
    const clause = likeClause(['text', 'scope'], terms);
    const filter = scopeClause('scope', scope, false);
    const rows = s.db.prepare(`
      SELECT * FROM notes
      WHERE deleted_at IS NULL AND superseded_by IS NULL AND ${clause.sql} ${filter.sql}
      ORDER BY importance DESC, ts DESC LIMIT ?
    `).all(...clause.params, ...filter.params, limit);
    for (const row of rows) push(row, 0);
  }
  return [...found.values()];
}

function searchFacts(s, terms, limit, scope) {
  if (!terms.length) return [];
  const found = new Map();
  const push = (row, textScore) => {
    const id = Number(row.id);
    const candidate = {
      kind: 'fact',
      id,
      ts: Number(row.valid_from),
      subject: row.subject,
      relation: row.relation,
      object: row.object,
      validFrom: Number(row.valid_from),
      validTo: row.valid_to === null ? null : Number(row.valid_to),
      contested: Number(row.contested ?? 0) === 1,
      source: row.source ?? '',
      scope: row.scope ?? null,
      text: String(row.text).slice(0, 400),
      score: 0.6 * Math.max(0.7, textScore, matchRatio(row, ['text', 'subject', 'object'], terms))
        + 0.2 * Number(row.confidence ?? 0.7)
        + 0.2 * recencyScore(row.valid_from),
    };
    const previous = found.get(id);
    if (!previous || candidate.score > previous.score) found.set(id, candidate);
  };

  if (s.fts.facts) {
    const filter = scopeClause('f.scope', scope);
    const bigramFilter = scopeClause('t.scope', scope);
    for (const term of terms.slice(0, 6)) {
      if (term.length === 2 && CJK_BIGRAM.test(term)) {
        const rows = searchBigrams(s, 'fact', 'facts', term, limit, bigramFilter, 'AND t.valid_to IS NULL');
        for (const row of rows) push(row, 1);
        continue;
      }
      if (term.length < 3) continue;
      try {
        const rows = s.db.prepare(`
          SELECT f.*, bm25(facts_fts) AS r
          FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid
          WHERE facts_fts MATCH ? AND f.deleted_at IS NULL AND f.valid_to IS NULL
          ${filter.sql}
          ORDER BY r LIMIT ?
        `).all(`"${term.replaceAll('"', '""')}"`, ...filter.params, limit);
        for (const row of rows) push(row, 1 / (1 + Math.abs(Number(row.r ?? 1))));
      } catch { /* term not indexable */ }
    }
  }

  if (found.size < limit) {
    const clause = likeClause(['text', 'subject', 'object'], terms);
    const filter = scopeClause('scope', scope);
    const rows = s.db.prepare(`
      SELECT * FROM facts
      WHERE deleted_at IS NULL AND valid_to IS NULL AND ${clause.sql} ${filter.sql}
      ORDER BY confidence DESC, valid_from DESC LIMIT ?
    `).all(...clause.params, ...filter.params, limit);
    for (const row of rows) push(row, 0);
  }
  return [...found.values()];
}

function textBlock(text) {
  return [{ type: 'text', text }];
}

/**
 * Dreaming: verify notes against the transcripts they came from.
 *
 * This is deliberately deterministic. A model could judge contradictions better,
 * but a background verifier that costs a model call per note is a verifier nobody
 * leaves on. Coverage of the note's tokens in the cited evidence is a proxy for
 * "is this claim actually supported by what was said"; anything below the weak
 * threshold is flagged for review and, when applying, superseded by a note built
 * from the evidence itself — the old row stays readable for audit.
 */
const DREAM_SUPPORTED = 0.8;
const DREAM_WEAK = 0.4;
const DREAM_MAX_NOTES = 100;
const DREAM_MAX_CHUNKS = 300;

function dreamEvidence(s, note, scope = note.scope ?? SCOPE_GLOBAL) {
  const scopeFilter = scopeClause('scope', scope);
  if (note.source) {
    try {
      const rows = s.db.prepare(`
        SELECT id, text, source FROM chunks
        WHERE source = ? AND deleted_at IS NULL ${scopeFilter.sql}
        LIMIT 1
      `).all(note.source, ...scopeFilter.params);
      if (rows.length) return rows[0];
    } catch { /* fall through to similarity */ }
  }
  const tokens = [...new Set(tokenize(note.text))].filter(token => token.length >= 2);
  if (!tokens.length) return null;
  let best = null;
  let bestScore = 0;
  let rows = [];
  try {
    rows = s.db.prepare(`
      SELECT id, text, source FROM chunks
      WHERE deleted_at IS NULL ${scopeFilter.sql}
      ORDER BY ts DESC LIMIT ?
    `).all(...scopeFilter.params, DREAM_MAX_CHUNKS);
  } catch { return null; }
  for (const row of rows) {
    const haystack = String(row.text ?? '');
    let hits = 0;
    for (const token of tokens) if (haystack.includes(token)) hits += 1;
    const score = hits / tokens.length;
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  return bestScore >= DREAM_WEAK ? best : null;
}

function coverageScore(noteText, evidenceText) {
  const tokens = [...new Set(tokenize(noteText))];
  if (!tokens.length) return 0;
  const haystack = String(evidenceText ?? '');
  let hits = 0;
  for (const token of tokens) if (haystack.includes(token)) hits += 1;
  return hits / tokens.length;
}

function dreamRun(s, apply) {
  const notes = s.db.prepare(`
    SELECT * FROM notes
    WHERE deleted_at IS NULL AND superseded_by IS NULL AND COALESCE(revision, 1) < 3
    ORDER BY importance DESC, ts DESC LIMIT ?
  `).all(DREAM_MAX_NOTES);
  const actions = [];
  for (const note of notes) {
    const evidence = dreamEvidence(s, note, note.scope ?? SCOPE_GLOBAL);
    let verdict = 'no_source';
    let score = 0;
    let evidenceRef = null;
    let missingTokens = [];
    if (evidence) {
      score = coverageScore(note.text, evidence.text);
      // Coverage alone cannot see a swapped value: "Docker" vs "裸机" is one word
      // out of twenty. A distinctive latin/number token present in the note but
      // absent from the evidence is the deterministic signal available without a
      // model call.
      const distinctive = [...new Set(tokenize(note.text))]
        .filter(token => token.length >= 3 && /^[a-z0-9_.-]+$/.test(token));
      missingTokens = distinctive.filter(token => !String(evidence.text ?? '').toLowerCase().includes(token));
      if (score >= 0.6 && missingTokens.length) verdict = 'contradicted';
      else if (score >= DREAM_SUPPORTED) verdict = 'supported';
      else if (score >= DREAM_WEAK) verdict = 'weak';
      else verdict = 'unsupported';
      evidenceRef = evidence.source || `chunk:${evidence.id}`;
    }
    const action = {
      noteId: Number(note.id),
      verdict,
      score: Number(score.toFixed(2)),
      evidence: evidenceRef,
      ...(missingTokens.length ? { missingTokens } : {}),
    };
    if (apply) {
      transaction(s.db, () => {
        s.db.prepare('UPDATE notes SET verified_at = ?, verification = ?, evidence = ? WHERE id = ?')
          .run(now(), verdict, evidenceRef, Number(note.id));
        if ((verdict === 'unsupported' || verdict === 'contradicted') && evidence) {
          s.db.prepare('UPDATE notes SET contested = 1 WHERE id = ?').run(Number(note.id));
          const replacementText = String(evidence.text).slice(0, 600);
          const info = s.db.prepare(
            'INSERT INTO notes(ts, scope, text, importance, source, revision) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(now(), note.scope, replacementText, 0.5, `dream:${note.id}`, Number(note.revision ?? 1) + 1);
          const replacementId = Number(info.lastInsertRowid);
          s.db.prepare('UPDATE notes SET superseded_by = ? WHERE id = ?').run(replacementId, Number(note.id));
          if (s.fts.notes) {
            try {
              s.db.prepare('INSERT INTO notes_fts(rowid, text) VALUES (?, ?)')
                .run(replacementId, replacementText);
            } catch { /* best effort */ }
          }
          indexBigrams(s.db, 'note', replacementId, replacementText);
          upsertVector(s, 'note', replacementId, replacementText);
          action.replacementId = replacementId;
        }
      });
    }
    actions.push(action);
  }
  if (apply) invalidateProfile();
  return { scanned: notes.length, applied: Boolean(apply), actions };
}

/** Vector route: cosine over the stored hashed n-gram vectors. */
const VECTOR_MIN_COSINE = 0.2;
const RRF_K = 60;

async function vectorSearch(s, queryText, limit, scope) {
  const config = backendConfig();
  let dim = activeVectorDim();
  if (!dim && config.kind === 'remote') dim = await ensureRemoteDim(s);
  if (!dim) return [];
  let queryVector;
  try {
    if (config.kind === 'hashed') {
      queryVector = embedText(queryText);
    } else {
      const vectors = await embedRemote([queryText], config);
      queryVector = vectors[0];
    }
  } catch {
    return [];
  }
  if (![...queryVector].some(value => value !== 0)) return [];
  // A hashed n-gram model is not semantic: unrelated text can still produce a
  // small positive cosine by collision. Require one shared token for that
  // backend only; a real embedding model has no such limitation.
  const queryTokens = config.kind === 'hashed' ? new Set(tokenize(queryText)) : null;
  const specs = [
    { kind: 'note', table: 'notes', nulls: false, extra: 'AND t.superseded_by IS NULL' },
    { kind: 'fact', table: 'facts', nulls: true, extra: 'AND t.valid_to IS NULL' },
    { kind: 'chunk', table: 'chunks', nulls: true, extra: '' },
  ];
  const out = [];
  for (const spec of specs) {
    let rows;
    const filter = scopeClause('t.scope', scope, spec.nulls);
    try {
      rows = s.db.prepare(`
        SELECT v.owner_id AS owner_id, v.vec AS vec, t.*
        FROM vectors v JOIN ${spec.table} t ON t.id = v.owner_id
        WHERE v.kind = ? AND v.dim = ? AND t.deleted_at IS NULL ${spec.extra} ${filter.sql}
      `).all(spec.kind, dim, ...filter.params);
    } catch {
      continue;
    }
    for (const row of rows) {
      let score = 0;
      try { score = dot(queryVector, fromBlob(row.vec, dim)); } catch { continue; }
      if (!Number.isFinite(score) || score < VECTOR_MIN_COSINE) continue;
      if (queryTokens) {
        const documentTokens = tokenize(String(row.text ?? ''));
        if (!documentTokens.some(token => queryTokens.has(token))) continue;
      }
      out.push({
        kind: spec.kind,
        id: Number(row.owner_id),
        ts: Number(row.ts ?? row.valid_from ?? 0),
        text: String(row.text ?? '').slice(0, 400),
        source: row.source ?? '',
        score,
        cosine: score,
        via: 'vector',
      });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

/** Drop duplicate sentences across layers, keeping the best-scoring copy. */
function finalizeHits(ranked, limit) {
  const seen = new Set();
  const hits = [];
  for (const hit of ranked) {
    if (hits.length >= limit) break;
    const key = String(hit.text).replace(/\s+/g, '').slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(hit);
  }
  return { total: hits.length, hits };
}

/** Reciprocal rank fusion of the lexical and vector routes. */
const CONTRADICTION_COSINE = 0.9;const GRAPH_HOPS = 2;
const GRAPH_DECAY = 0.5;
const GRAPH_MAX_SEEDS = 6;
let entityCache = { names: [], at: 0 };
const ENTITY_CACHE_MS = 30_000;

/**
 * Mark near-duplicate or explicitly contradicted notes as contested.
 *
 * There is no model call here: an LLM judgement would add latency and cost to
 * every write, and a wrong silent merge is worse than a visible flag. The caller
 * can declare a contradiction explicitly (`contradicts`), and near-identical
 * text is flagged by cosine similarity for human review.
 */
function markContradictions(s, noteId, text, explicit, scope = null) {
  const ids = new Set();
  const scopeFilter = scope ? 'AND scope = ?' : '';
  const exists = s.db.prepare(`SELECT id FROM notes WHERE id = ? AND deleted_at IS NULL AND superseded_by IS NULL ${scopeFilter}`);
  for (const value of Array.isArray(explicit) ? explicit : []) {
    const id = Number(value);
    if (!Number.isFinite(id) || id <= 0 || id === noteId) continue;
    const row = scope ? exists.get(id, scope) : exists.get(id);
    if (!row) continue;
    ids.add(id);
  }
  try {
    const vector = embedText(text);
    const rows = s.db.prepare(`
      SELECT id, text FROM notes
      WHERE deleted_at IS NULL AND superseded_by IS NULL AND contested = 0 AND id != ? ${scopeFilter}
      ORDER BY ts DESC LIMIT 500
    `).all(...(scope ? [noteId, scope] : [noteId]));
    for (const row of rows) {
      const id = Number(row.id);
      if (ids.has(id)) continue;
      if (dot(vector, embedText(row.text)) >= CONTRADICTION_COSINE) ids.add(id);
    }
  } catch { /* similarity flagging is best effort */ }
  if (ids.size) {
    const mark = s.db.prepare('UPDATE notes SET contested = 1 WHERE id = ? AND deleted_at IS NULL');
    for (const id of ids) mark.run(id);
    mark.run(noteId);
  }
  return [...ids];
}

function entityNames(s) {
  // `at: 0` means "never loaded": a zero timestamp must not pass the freshness
  // check, otherwise the empty initial list would be treated as a valid cache.
  if (entityCache.at > 0 && now() - entityCache.at < ENTITY_CACHE_MS) return entityCache.names;
  let names = [];
  try {
    names = s.db.prepare('SELECT name FROM entities LIMIT 5000').all()
      .map(row => String(row.name ?? ''))
      .filter(Boolean);
  } catch { names = []; }
  entityCache = { names, at: now() };
  return names;
}

/**
 * Graph route: weighted 2-hop expansion over entity edges (a PPR-lite).
 *
 * Seeds come from entities mentioned by the current best hits; neighbours get a
 * decayed weight, and only the *expanded* entities produce candidates, so the
 * route adds associations instead of repeating what lexical/vector already found.
 */
function graphExpand(s, hits, limit, scope) {
  if (process.env.OMNI_DISABLE_GRAPH === '1') return [];
  const names = entityNames(s);
  if (!names.length) return [];
  const seeds = new Set();
  for (const hit of hits.slice(0, GRAPH_MAX_SEEDS)) {
    const text = String(hit.text ?? '');
    for (const name of names) {
      if (text.includes(name)) seeds.add(name);
      if (seeds.size >= 8) break;
    }
    if (seeds.size >= 8) break;
  }
  if (!seeds.size) return [];

  const weights = new Map([...seeds].map(name => [name, 1]));
  const discovered = [];
  let frontier = [...seeds];
  for (let hop = 0; hop < GRAPH_HOPS && frontier.length; hop += 1) {
    const weight = GRAPH_DECAY ** (hop + 1);
    const next = [];
    for (const node of frontier) {
      let rows = [];
      const edgeScope = scopeClause('scope', scope);
      try {
        rows = s.db.prepare(`
          SELECT src, rel, dst FROM edges
          WHERE (src = ? OR dst = ?) AND (valid_to IS NULL OR valid_to > ?)
          ${edgeScope.sql}
          LIMIT 50
        `).all(node, node, now(), ...edgeScope.params);
      } catch { continue; }
      for (const row of rows) {
        const other = row.src === node ? row.dst : row.src;
        if (!other || weights.has(other)) continue;
        weights.set(other, weight);
        next.push(other);
        // The traversed edge is the association worth surfacing: querying a
        // concept should reveal the links that leave it, not unrelated facts
        // that merely mention the neighbour.
        discovered.push({
          subject: row.src,
          relation: row.rel,
          object: row.dst,
          weight,
        });
      }
    }
    frontier = next;
  }

  if (!discovered.length) return [];

  const out = [];
  const seen = new Set();
  const pushFact = (row, weight) => {
    const key = `fact:${row.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      kind: 'fact',
      id: Number(row.id),
      ts: Number(row.valid_from),
      subject: row.subject,
      relation: row.relation,
      object: row.object,
      validFrom: Number(row.valid_from),
      validTo: row.valid_to === null ? null : Number(row.valid_to),
      contested: Number(row.contested ?? 0) === 1,
      source: row.source ?? '',
      text: String(row.text).slice(0, 400),
      score: weight,
      via: 'graph',
    });
  };

  discovered.sort((a, b) => b.weight - a.weight);
  for (const edge of discovered) {
    if (out.length >= limit) break;
    try {
      const row = s.db.prepare(`
        SELECT * FROM facts
        WHERE deleted_at IS NULL AND valid_to IS NULL
          AND subject = ? AND relation = ? AND object = ?
        ${scopeClause('scope', scope).sql}
        ORDER BY valid_from DESC LIMIT 1
      `).get(edge.subject, edge.relation, edge.object, ...scopeClause('scope', scope).params);
      if (row) pushFact(row, edge.weight);
    } catch { /* ignore */ }
  }
  return out.slice(0, limit);
}

async function runSearch(s, query, limit, scope) {  const terms = queryTerms(query);
  const lexical = terms.length
    ? rank([
        ...searchNotes(s, terms, limit, scope),
        ...searchFacts(s, terms, limit, scope),
        ...searchChunks(s, terms, limit, scope),
      ])
    : [];
  // Diagnostic switch: OMNI_DISABLE_VECTOR=1 measures the lexical route alone.
  const useVector = process.env.OMNI_DISABLE_VECTOR !== '1';
  if (useVector) await flushPendingVectors(s);
  const vector = useVector ? await vectorSearch(s, query, limit, scope) : [];
  const graph = graphExpand(s, [...lexical, ...vector], Math.min(limit, 10), scope);
  if (!vector.length && !graph.length) return finalizeHits(lexical, limit);

  const fused = new Map();
  const add = (hit, index) => {
    const key = `${hit.kind}:${hit.id}`;
    const entry = fused.get(key) ?? { hit, rrf: 0, lexical: null, vector: null, graph: null };
    entry.rrf += 1 / (RRF_K + index + 1);
    if (hit.via === 'vector') {
      entry.vector = hit.score;
      entry.hit = { ...entry.hit, vectorScore: hit.score };
    } else if (hit.via === 'graph') {
      entry.graph = hit.score;
      entry.hit = { ...entry.hit, graphScore: hit.score };
    } else {
      entry.lexical = hit.score;
      entry.hit = { ...entry.hit, lexicalScore: hit.score };
    }
    fused.set(key, entry);
  };
  lexical.forEach((hit, index) => add(hit, index));
  vector.forEach((hit, index) => add(hit, index));
  graph.forEach((hit, index) => add(hit, index));

  const ranked = [...fused.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .map(entry => ({
      ...entry.hit,
      score: Number(entry.rrf.toFixed(6)),
      rrf: Number(entry.rrf.toFixed(6)),
      lexicalScore: entry.lexical,
      vectorScore: entry.vector,
      graphScore: entry.graph,
    }));
  return finalizeHits(ranked, limit);
}

/** Read the highest-importance notes that fit the always-injected budget. */
function buildProfileText(projectKey) {
  const s = openStore();
  const rows = s.db.prepare(
    'SELECT id, text, importance, scope FROM notes WHERE deleted_at IS NULL AND superseded_by IS NULL AND contested = 0 ORDER BY importance DESC, ts DESC LIMIT 60'
  ).all();
  // Global notes follow the model everywhere; project notes only in their own
  // project. Unknown project => global only, so one project cannot leak into
  // another through the always-injected block.
  const visible = rows.filter(row => {
    const scope = String(row.scope ?? 'global');
    if (scope === 'global' || scope === '') return true;
    return projectKey ? scope === projectKey : false;
  });
  const lines = [];
  let used = 0;
  for (const row of visible) {
    const line = `- ${row.text}`;
    if (used + line.length > PROFILE_BUDGET) continue;
    used += line.length;
    lines.push(line);
  }
  return lines.join('\n');
}

const profileCache = new Map();

function cachedProfile(projectKey) {
  const key = projectKey || 'global';
  const cached = profileCache.get(key);
  const nowMs = now();
  if (cached && nowMs - cached.at < PROFILE_CACHE_MS) return cached.text;
  let text = '';
  try {
    text = buildProfileText(projectKey);
  } catch {
    text = '';
  }
  profileCache.set(key, { text, at: nowMs });
  return text;
}

function invalidateProfile() {
  profileCache.clear();
}

function inboxText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n').trim();
}

/** Precompute recall for an incoming user message; never blocks the turn. */
async function precomputeRecall(agentId, text) {
  try {
    const project = projectByAgent.get(agentId) ?? SCOPE_GLOBAL;
    const result = await runSearch(openStore(), text, 3, project);
    recallByAgent.set(agentId, { hits: result.hits, query: text, at: now(), project });
  } catch { /* recall is best effort */ }
}

function projectForAgentId(agentId) {
  const id = String(agentId ?? '');
  if (!id) return null;
  const known = projectByAgent.get(id);
  if (known) return known;
  const cwd = cwdBySession.get(id);
  return cwd ? projectKeyFromCwd(cwd) : null;
}

/**
 * Resolve the project for one prompt assembly.
 *
 * `AssembleContext.scope` is an opaque ScopeKey. If it cannot be resolved, only
 * the global layer may be injected. The previous fallback to the last project
 * seen anywhere turned a concurrent or unknown session into a cross-project
 * leak, so it is deliberately gone.
 */
function projectForScope(scope) {
  const id = scope?.id ? String(scope.id) : '';
  if (!id) return null;
  const known = projectForAgentId(id);
  if (known) return known;
  // The host may hand over a truncated or opaque id (for example `session-b707`).
  // Match it as a prefix of a captured session so the current turn keeps its
  // project, while an unrelated session id still resolves to nothing.
  for (const [sessionId, cwd] of cwdBySession) {
    const short = shortId(id);
    if (sessionId.startsWith(short) || short.startsWith(sessionId.slice(0, short.length))) {
      const project = projectKeyFromCwd(cwd);
      if (project !== SCOPE_GLOBAL) return project;
    }
  }
  return null;
}

function shortId(id) {
  return String(id ?? '').slice(0, Math.min(12, String(id ?? '').length));
}

function rememberUserMessage(agent, message) {
  try {
    const agentId = String(agent?.id ?? '');
    if (!agentId) return;
    const text = inboxText(message);
    if (!text) return;
    lastUserByAgent.set(agentId, { text, at: now() });
    lastClaimAt = now();
    const cwd = cwdBySession.get(agentId);
    if (cwd) {
      const project = projectKeyFromCwd(cwd);
      projectByAgent.set(agentId, project);
    }
    if (!autoRecallEnabled()) return;
    void precomputeRecall(agentId, text);
  } catch { /* never break the loop */ }
}

function recallFor(scope) {
  if (!autoRecallEnabled()) return null;
  const agentId = String(scope?.id ?? '');
  if (!agentId) return null;
  const entry = recallByAgent.get(agentId);
  if (!entry) return null;
  if (now() - entry.at > AUTO_RECALL_TTL_MS) return null;
  return entry;
}

function messageText(data) {
  const blocks = Array.isArray(data?.message?.content) ? data.message.content : [];
  return blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n').trim();
}

/**
 * Capture committed session events into the transcript layer. This listens to
 * the post-commit feed only: it never prepares a Session, never reads a
 * projection, and never blocks the turn.
 */
function captureEvent(session, event) {
  try {
    const type = String(event?.type ?? '');
    if (type !== 'user/message' && type !== 'assistant/message') return;
    const text = messageText(event.data);
    if (!text) return;
    const sessionId = String(session?.id ?? '');
    const scope = scopeForSession(session);
    const role = type === 'user/message' ? 'user' : 'assistant';
    const source = `session:${sessionId}#${String(event.seq ?? '')}`;
    insertChunk(openStore(), {
      text: text.length > MAX_CAPTURE_CHARS ? text.slice(0, MAX_CAPTURE_CHARS) : text,
      role,
      ts: Number(event.time ?? now()),
      sessionId,
      source,
      importance: role === 'user' ? 0.6 : 0.4,
      scope,
    });
  } catch { /* capture must never break a turn */ }
}

/** Resolve (and remember) the project scope of a session from its workspace. */
function scopeForSession(session) {
  const sessionId = String(session?.id ?? '');
  const cwd = session?.header?.cwd;
  if (cwd) cwdBySession.set(sessionId, String(cwd));
  const known = cwdBySession.get(sessionId);
  return known ? projectKeyFromCwd(known) : SCOPE_GLOBAL;
}

function defineTools(ctx) {
  const disposers = [];

  disposers.push(ctx.tools.register({
    name: 'memory_write',
    description: 'Store one durable memory. kind=note for conclusions and rules, kind=fact for subject/relation/object triples, kind=episode for raw observations. Returns the stored id.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['note', 'fact', 'episode'], description: 'Which layer to write.' },
        text: { type: 'string', description: 'The memory, stated so it is useful without the original conversation.' },
        scope: {
          type: 'string',
          description: 'Optional. Omit to let the plugin judge: project-specific wording goes to the current project layer, cross-project rules to global. Pass a project key or global to override; all is read-only and rejected.',
        },
        importance: { type: 'number', description: '0..1; higher survives prompt-budget trimming longer.' },
        source: { type: 'string', description: 'Where this came from, e.g. session id plus turn, or a file path.' },
        subject: { type: 'string', description: 'fact only: the entity.' },
        relation: { type: 'string', description: 'fact only: the predicate.' },
        object: { type: 'string', description: 'fact only: the value.' },
        contradicts: {
          type: 'array',
          items: { type: 'number' },
          description: 'note only: ids of earlier notes this one contradicts. Both sides are flagged contested for review; nothing is merged or deleted.',
        },
      },
      required: ['kind', 'text'],
    },
    output: {
      schema: { type: 'object', properties: { id: { type: 'number' }, kind: { type: 'string' }, deduped: { type: 'boolean' } } },
      render: (_args, value) => {
      const layer = value.scope === 'global' ? 'global' : (value.scope ? 'project' : '');
      const detail = layer ? ` · ${layer}` : '';
      const reason = value.scopeReason && value.scopeReason !== 'explicit' ? ` (${value.scopeReason})` : '';
      return textBlock(`stored ${value.kind} #${value.id}${detail}${reason}${value.deduped ? ' (duplicate)' : ''}`);
    },
    },
    async execute(args, toolContext = {}) {
      const s = openStore();
      const kind = String(args.kind ?? 'note');
      const text = String(args.text ?? '');
      const importance = Number.isFinite(args.importance) ? Number(args.importance) : 0.5;
      const project = currentProject(toolContext);
      if (kind === 'fact') {
        const subject = String(args.subject ?? '').trim();
        const relation = String(args.relation ?? 'is').trim();
        const object = String(args.object ?? args.text ?? '').trim();
        if (!subject) throw new Error('subject is required for kind=fact');
        const decision = decideScope(args.scope, text, project);
        const factScope = decision.scope;
        const ts = now();
        // Contradiction handling: same subject+relation in the same layer with a
        // different object is invalidated, not deleted. A project write must not
        // expire a global fact, and a global write must not expire project facts.
        const scopeFilter = factScope === SCOPE_GLOBAL
          ? "(scope = 'global' OR scope IS NULL)"
          : 'scope = ?';
        const previous = s.db.prepare(`
          SELECT id, object, scope FROM facts
          WHERE subject = ? AND relation = ? AND valid_to IS NULL AND deleted_at IS NULL
            AND ${scopeFilter}
        `).all(subject, relation, ...(factScope === SCOPE_GLOBAL ? [] : [factScope]));
        const result = transaction(s.db, () => {
          for (const row of previous) {
            s.db.prepare('UPDATE facts SET valid_to = ? WHERE id = ?').run(ts, Number(row.id));
            // Edges are the graph projection of a fact. If the fact stops being
            // current, the edge must stop being traversable too.
            s.db.prepare(`
              UPDATE edges SET valid_to = ?
              WHERE src = ? AND rel = ? AND dst = ? AND valid_to IS NULL
                AND (scope = ? OR scope IS NULL)
            `).run(ts, subject, relation, String(row.object ?? ''), row.scope ?? SCOPE_GLOBAL);
          }
          const info = s.db.prepare(`
            INSERT INTO facts(subject, relation, object, text, valid_from, valid_to, recorded_at, confidence, source, scope)
            VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
          `).run(
            subject, relation, object, text || `${subject} ${relation} ${object}`,
            ts, ts, 0.7, args.source ?? null, factScope,
          );
          const factId = Number(info.lastInsertRowid);
          if (s.fts.facts) {
            try {
              s.db.prepare('INSERT INTO facts_fts(rowid, text) VALUES (?, ?)')
                .run(factId, text || `${subject} ${relation} ${object}`);
            } catch { /* index write is best effort */ }
          }
          indexBigrams(s.db, 'fact', factId, text || `${subject} ${relation} ${object}`);
          upsertVector(s, 'fact', factId, text || `${subject} ${relation} ${object}`);
          s.db.prepare('INSERT OR IGNORE INTO entities(name) VALUES (?)').run(subject);
          if (object && object.length <= 80) s.db.prepare('INSERT OR IGNORE INTO entities(name) VALUES (?)').run(object);
          s.db.prepare('INSERT INTO edges(src, rel, dst, valid_from, scope, source) VALUES (?, ?, ?, ?, ?, ?)')
            .run(subject, relation, object, ts, factScope, args.source ?? null);
          return { factId };
        });
        entityCache = { names: [], at: 0 };
        invalidateProfile();
        enqueueJudge(ctx, {
          kind: 'fact', table: 'facts', id: Number(result.factId),
          text: text || `${subject} ${relation} ${object}`,
          project, scope: factScope, confidence: decision.confidence, reason: decision.reason,
        });
        return {
          id: Number(result.factId),
          kind: 'fact',
          deduped: false,
          invalidated: previous.length,
          scope: factScope,
          scopeReason: decision.reason,
        };
      }
      if (kind === 'episode') {
        const decision = decideScope(args.scope, text, project);
        const row = insertChunk(s, {
          text, role: 'note', importance, source: args.source, sessionId: null,
          scope: decision.scope,
        });
        if (!row) throw new Error('text is required');
        invalidateProfile();
        enqueueJudge(ctx, {
          kind: 'episode', table: 'chunks', id: Number(row.id), text,
          project, scope: decision.scope, confidence: decision.confidence, reason: decision.reason,
        });
        return { id: row.id, kind: 'episode', deduped: row.deduped, scope: decision.scope, scopeReason: decision.reason };
      }
      const ts = now();
      const decision = decideScope(args.scope, text, project);
      const scope = decision.scope;
      if (!text.trim()) throw new Error('text is required');
      // Scope is part of a note's identity: the same wording in two layers is two
      // deliberate records (a global rule and its project-specific restatement).
      const prev = s.db.prepare(
        'SELECT id FROM notes WHERE scope = ? AND text = ? AND deleted_at IS NULL AND superseded_by IS NULL'
      ).get(scope, text);
      if (prev) {
        return {
          id: Number(prev.id),
          kind: 'note',
          deduped: true,
          scope,
          scopeReason: decision.reason,
        };
      }
      const result = transaction(s.db, () => {
        const info = s.db.prepare(
          'INSERT INTO notes(ts, scope, text, importance, source) VALUES (?, ?, ?, ?, ?)'
        ).run(ts, scope, text, importance, args.source ?? null);
        const noteId = Number(info.lastInsertRowid);
        if (s.fts.notes) {
          try {
            s.db.prepare('INSERT INTO notes_fts(rowid, text) VALUES (?, ?)')
              .run(noteId, text);
          } catch { /* index write is best effort */ }
        }
        indexBigrams(s.db, 'note', noteId, text);
        upsertVector(s, 'note', noteId, text);
        const contestedWith = markContradictions(s, noteId, text, args.contradicts, scope);
        return { noteId, contestedWith };
      });
      invalidateProfile();
      enqueueJudge(ctx, {
        kind: 'note', table: 'notes', id: Number(result.noteId), text,
        project, scope, confidence: decision.confidence, reason: decision.reason,
      });
      return {
        id: Number(result.noteId),
        kind: 'note',
        deduped: false,
        contested: result.contestedWith.length > 0,
        contestedWith: result.contestedWith,
        scope,
        scopeReason: decision.reason,
      };
    },
  }));

  disposers.push(ctx.tools.register({
    name: 'memory_search',
    description: 'Hybrid recall over stored notes, facts and transcripts. Returns ranked hits with source pointers. Use scope to narrow to a project.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Keywords, an entity, a file path, or a phrase from the original wording.' },
        limit: { type: 'number', description: 'Maximum hits, default 8, max 30.' },
        scope: {
          type: 'string',
          description: "Optional layer filter: a project scope (returns that project plus global), 'global', or 'all'. Omit to use the current project when one is known.",
        },
      },
      required: ['query'],
    },
    output: {
      schema: { type: 'object', properties: { total: { type: 'number' }, scope: { type: 'string' }, hits: { type: 'array', items: { type: 'object' } } } },
      render: (_args, value) => {
        if (!value.hits.length) return textBlock(`no memory matched (scope ${value.scope ?? 'all'})`);
        const lines = value.hits.map((hit, index) => {
          const pointer = hit.source ? ` · ${hit.source}` : '';
          const flag = hit.contested ? ' · contested' : '';
          const layer = hit.scope && hit.scope !== 'global' ? ` · ${hit.scope}` : '';
          return `${index + 1}. [${hit.kind}#${hit.id}${layer}${flag}] ${hit.text.replace(/\s+/g, ' ')}${pointer}`;
        });
        return textBlock(`matched ${value.total} (scope ${value.scope ?? 'all'})\n${lines.join('\n')}`);
      },
    },
    async execute(args, toolContext = {}) {
      const s = openStore();
      const limit = Math.min(30, Math.max(1, Number(args.limit ?? 8)));
      const query = String(args.query ?? '');
      const requested = String(args.scope ?? '').trim();
      // Retrieval judgement: an explicit request wins; otherwise scope to the
      // current project (plus the global layer), never to every project.
      const scope = requested === 'all' ? null : (requested || currentProject(toolContext) || SCOPE_GLOBAL);
      if (!queryTerms(query).length) return { total: 0, scope: scope ?? 'all', hits: [] };
      const result = await runSearch(s, query, limit, scope);
      return { ...result, scope: scope ?? 'all' };
    },
  }));

  disposers.push(ctx.tools.register({
    name: 'memory_reindex',
    description: 'Rebuild missing vectors for the active embedding backend. Use after switching OMNI_EMBED_URL/model or restoring an old database.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', description: 'Maximum rows to process this call, default 200, max 1000.' },
      },
    },
    output: {
      schema: { type: 'object', properties: { processed: { type: 'number' }, queued: { type: 'number' }, backend: { type: 'string' } } },
      render: (_args, value) => textBlock(`reindexed ${value.processed} rows (${value.backend}${value.queued ? `, ${value.queued} queued` : ''})`),
    },
    async execute(args = {}) {
      const s = openStore();
      const config = backendConfig();
      const limit = Math.min(1000, Math.max(1, Number(args.limit ?? 200)));
      if (config.kind === 'hashed') {
        const before = Number(s.db.prepare('SELECT COUNT(*) AS n FROM vectors').get().n);
        backfillVectors(s.db);
        const after = Number(s.db.prepare('SELECT COUNT(*) AS n FROM vectors').get().n);
        return { processed: Math.max(0, after - before), queued: 0, backend: 'hashed' };
      }
      const dim = await ensureRemoteDim(s);
      if (!dim) throw new Error('remote embedding endpoint did not return a dimension');
      let processed = 0;
      while (processed < limit) {
        await backfillRemoteBatch(s);
        const before = pendingVectors.size;
        if (!before) break;
        await flushPendingVectors(s);
        const after = pendingVectors.size;
        if (after >= before) break;
        processed += before - after;
      }
      return { processed, queued: pendingVectors.size, backend: `remote:${dim}` };
    },
  }));

  disposers.push(ctx.tools.register({
    name: 'memory_profile',
    description: 'Read the hot memory profile: the highest-importance notes that fit the always-injected budget, plus store statistics. Scope defaults to the current project, or global when unknown.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: {
          type: 'string',
          description: "Optional layer filter: a project scope (returns that project plus global), 'global', or 'all'. Omit to use the current project when known.",
        },
      },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, stats: { type: 'object' } } },
      render: (_args, value) => textBlock(value.text || 'memory is empty'),
    },
    async execute(args = {}, toolContext = {}) {
      const s = openStore();
      const requested = String(args.scope ?? '').trim();
      const scope = requested === 'all' ? null : (requested || currentProject(toolContext) || SCOPE_GLOBAL);
      const filter = scope ? scopeClause('scope', scope) : { sql: '', params: [] };
      const rows = s.db.prepare(`
        SELECT id, text, importance, source, scope FROM notes
        WHERE deleted_at IS NULL AND superseded_by IS NULL AND contested = 0 ${filter.sql}
        ORDER BY importance DESC, ts DESC LIMIT 60
      `).all(...filter.params);
      let used = 0;
      const picked = [];
      for (const row of rows) {
        const line = `- ${row.text}`;
        if (used + line.length > PROFILE_BUDGET) continue;
        used += line.length;
        picked.push({ id: Number(row.id), text: row.text, scope: row.scope });
      }
      const count = table => Number(s.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL`).get().n);
      const stats = {
        notes: count('notes'),
        facts: Number(s.db.prepare('SELECT COUNT(*) AS n FROM facts WHERE deleted_at IS NULL AND valid_to IS NULL').get().n),
        chunks: count('chunks'),
        db: path.basename(DB_FILE),
        fts: s.ftsMode,
      };
      const text = picked.length
        ? picked.map(item => `- ${item.text}`).join('\n')
        : '';
      return { text, stats, picked: picked.length, budget: PROFILE_BUDGET };
    },
  }));

  disposers.push(ctx.tools.register({
    name: 'memory_timeline',
    description: 'Show how knowledge about one entity changed over time: facts with their validity spans, plus notes that mention the entity.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        entity: { type: 'string', description: 'Subject or object name.' },
        scope: {
          type: 'string',
          description: "Optional layer filter: a project scope (returns that project plus global), 'global', or 'all'. Omit to use the current project when known.",
        },
      },
      required: ['entity'],
    },
    output: {
      schema: { type: 'object', properties: { entries: { type: 'array', items: { type: 'object' } } } },
      render: (_args, value) => {
        if (!value.entries.length) return textBlock('no entries for this entity');
        return textBlock(value.entries.map(entry => {
          if (entry.kind === 'note') {
            const date = new Date(entry.ts).toISOString().slice(0, 10);
            return `${date}  [note #${entry.id}] ${String(entry.text).replace(/\s+/g, ' ')}`;
          }
          const from = new Date(entry.validFrom).toISOString().slice(0, 10);
          const span = entry.validTo
            ? `${from} → ${new Date(entry.validTo).toISOString().slice(0, 10)}`
            : `${from} → now`;
          return `${span}  ${entry.subject} ${entry.relation} ${entry.object}`;
        }).join('\n'));
      },
    },
    async execute(args = {}, toolContext = {}) {
      const s = openStore();
      const name = String(args.entity ?? '').trim();
      if (!name) throw new Error('entity is required');
      const requested = String(args.scope ?? '').trim();
      const scope = requested === 'all' ? null : (requested || currentProject(toolContext) || SCOPE_GLOBAL);
      const factFilter = scope ? scopeClause('scope', scope) : { sql: '', params: [] };
      const noteFilter = scope ? scopeClause('scope', scope, false) : { sql: '', params: [] };
      const facts = s.db.prepare(`
        SELECT * FROM facts
        WHERE (subject = ? OR object LIKE ?) AND deleted_at IS NULL ${factFilter.sql}
        ORDER BY valid_from ASC LIMIT 50
      `).all(name, `%${name}%`, ...factFilter.params).map(row => ({
        kind: 'fact',
        subject: row.subject,
        relation: row.relation,
        object: row.object,
        validFrom: Number(row.valid_from),
        validTo: row.valid_to === null ? null : Number(row.valid_to),
      }));
      const notes = s.db.prepare(`
        SELECT id, ts, text, scope FROM notes
        WHERE deleted_at IS NULL AND text LIKE ? ${noteFilter.sql}
        ORDER BY ts ASC LIMIT 30
      `).all(`%${name}%`, ...noteFilter.params).map(row => ({
        kind: 'note',
        id: Number(row.id),
        ts: Number(row.ts),
        scope: row.scope,
        text: String(row.text).slice(0, 200),
      }));
      const entries = [...facts, ...notes]
        .sort((a, b) => (a.validFrom ?? a.ts) - (b.validFrom ?? b.ts));
      return { entries };
    },
  }));

  disposers.push(ctx.tools.register({
    name: 'memory_forget',
    description: 'Tombstone one memory by kind and id. The row stays auditable; it stops appearing in recall and the profile.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['note', 'fact', 'chunk'] },
        id: { type: 'number' },
      },
      required: ['kind', 'id'],
    },
    output: {
      schema: { type: 'object', properties: { forgotten: { type: 'boolean' } } },
      render: (_args, value) => textBlock(value.forgotten ? 'tombstoned' : 'nothing to forget'),
    },
    async execute(args) {
      const s = openStore();
      const forgotten = forgetMemory(s, String(args.kind), Number(args.id));
      invalidateProfile();
      return { forgotten };
    },
  }));

  disposers.push(ctx.tools.register({
    name: 'memory_dream',
    description: 'Verify stored notes against the transcripts they came from. Dry run by default; apply=true records each verdict, flags unsupported notes as contested, and supersedes them with a note built from the evidence (the old row stays readable).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        apply: { type: 'boolean', description: 'false (default) reports only; true writes verdicts and corrections.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          scanned: { type: 'number' },
          applied: { type: 'boolean' },
          actions: { type: 'array', items: { type: 'object' } },
        },
      },
      render: (_args, value) => {
        if (!value.scanned) return textBlock('no notes to verify');
        const counts = {};
        for (const action of value.actions) counts[action.verdict] = (counts[action.verdict] ?? 0) + 1;
        const summary = Object.entries(counts).map(([key, count]) => `${key}=${count}`).join(' ');
        const flagged = value.actions
          .filter(action => ['unsupported', 'weak', 'contradicted'].includes(action.verdict))
          .slice(0, 10);
        const lines = flagged.map(action =>
          `- note#${action.noteId} ${action.verdict} (coverage ${action.score})${action.replacementId ? ` -> note#${action.replacementId}` : ''}`
        );
        return textBlock(`${value.applied ? 'applied' : 'dry-run'} · scanned ${value.scanned} · ${summary}${lines.length ? '\n' + lines.join('\n') : ''}`);
      },
    },
    async execute(args) {
      const s = openStore();
      return dreamRun(s, args.apply === true);
    },
  }));

  disposers.push(ctx.tools.register({
    name: 'memory_compact',
    description: 'Bound transcript growth by tombstoning the oldest chunks beyond a keep limit. Rows stay auditable and recoverable; the raw record is never destroyed. Dry run by default.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        keepChunks: { type: 'number', description: 'How many newest chunks to keep. Default 5000, minimum 50.' },
        apply: { type: 'boolean', description: 'false (default) reports only; true tombstones the excess rows.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          total: { type: 'number' },
          excess: { type: 'number' },
          tombstoned: { type: 'number' },
          applied: { type: 'boolean' },
        },
      },
      render: (_args, value) => textBlock(
        `${value.applied ? 'applied' : 'dry-run'} · total ${value.total} · excess ${value.excess} · tombstoned ${value.tombstoned}`
      ),
    },
    async execute(args) {
      const s = openStore();
      const keep = Math.max(50, Number(args.keepChunks ?? 5000) || 5000);
      const apply = args.apply === true;
      const total = Number(s.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE deleted_at IS NULL').get().n);
      const excess = Math.max(0, total - keep);
      let tombstoned = 0;
      if (apply && excess > 0) {
        transaction(s.db, () => {
          const rows = s.db.prepare(
            'SELECT id FROM chunks WHERE deleted_at IS NULL ORDER BY ts ASC, id ASC LIMIT ?'
          ).all(excess);
          const stmt = s.db.prepare('UPDATE chunks SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL');
          for (const row of rows) tombstoned += Number(stmt.run(now(), Number(row.id)).changes);
        });
      }
      return { total, excess, tombstoned, applied: apply };
    },
  }));

  return disposers;
}

export const inject = ['tools'];

function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Request-forgery guard for mutating routes.
 *
 * A browser sends Origin on cross-site POSTs; a local non-browser client may
 * omit it. The custom header is deliberately simple: a malicious page cannot
 * send it without a CORS preflight, which this server never grants. This blocks
 * browser CSRF but does not authenticate another process running as the same
 * user -- that requires a host-level credential this plugin does not own.
 */
function sameOrigin(req) {
  const origin = String(req.headers?.origin ?? '').trim();
  if (!origin) return true;
  const host = String(req.headers?.host ?? '').trim();
  if (!host) return false;
  return origin === `http://${host}` || origin === `https://${host}`;
}

function mutationAllowed(req) {
  if (!sameOrigin(req)) return false;
  return String(req.headers?.['x-omni-csrf'] ?? '') === '1';
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

/** Read a small JSON request body; never trusts its size or shape. */
function readJsonBody(req, limit = 8192) {
  return new Promise(resolve => {
    if (!req || typeof req.on !== 'function') {
      resolve({});
      return;
    }
    let raw = '';
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(parse(raw)); } };
    const parse = text => {
      try { return JSON.parse(text || '{}'); } catch { return {}; }
    };
    req.on('data', chunk => {
      if (settled) return;
      raw += String(chunk);
      if (raw.length > limit) { raw = raw.slice(0, limit); done(); }
    });
    req.on('end', done);
    req.on('error', done);
  });
}

function registerRoutes(ctx) {
  let web;
  try {
    web = typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer;
  } catch {
    web = undefined;
  }
  if (!web || typeof web.register !== 'function') return undefined;

  const disposers = [];
  const add = route => {
    try {
      const dispose = web.register(route);
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch { /* a missing route is not fatal */ }
  };

  add({
    kind: 'exact',
    path: '/omni-memory/list',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { ok: false });
      const s = openStore();
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 40)));
      const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
      const scopeFilter = String(url.searchParams.get('scope') ?? 'all');
      // The working list shows live memory; `audit=1` keeps superseded notes and
      // expired facts browsable for review without mixing them into recall.
      const audit = String(url.searchParams.get('audit') ?? '') === '1';
      const noteActive = audit ? '' : 'AND superseded_by IS NULL';
      const factActive = audit ? '' : 'AND valid_to IS NULL';
      // Layer filter: 'all' | 'global' | 'project' (any proj:*), or one exact key.
      let scopeSql = '';
      let scopeParams = [];
      if (scopeFilter === 'global') {
        scopeSql = "AND (scope = 'global' OR scope IS NULL)";
      } else if (scopeFilter === 'project') {
        scopeSql = "AND scope LIKE 'proj:%'";
      } else if (scopeFilter !== 'all') {
        scopeSql = "AND (scope = ? OR scope = 'global' OR scope IS NULL)";
        scopeParams = [scopeFilter];
      }
      const notes = s.db.prepare(`
        SELECT id, ts, scope, text, importance, source, revision, contested,
               superseded_by, verification, verified_at, evidence
        FROM notes WHERE deleted_at IS NULL ${noteActive} ${scopeSql}
        ORDER BY importance DESC, ts DESC LIMIT ? OFFSET ?
      `).all(...scopeParams, limit, offset);
      const facts = s.db.prepare(`
        SELECT id, subject, relation, object, text, confidence, source,
               valid_from, valid_to, contested, scope
        FROM facts WHERE deleted_at IS NULL ${factActive} ${scopeSql}
        ORDER BY valid_from DESC LIMIT ? OFFSET ?
      `).all(...scopeParams, limit, offset);
      const count = (table, extra = '', params = []) => Number(s.db.prepare(
        `SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL ${extra}`
      ).get(...params).n);
      const totalNotes = count('notes', `${noteActive} ${scopeSql}`, scopeParams);
      const totalFacts = count('facts', `${factActive} ${scopeSql}`, scopeParams);
      const globalNotes = count('notes', "AND superseded_by IS NULL AND (scope = 'global' OR scope IS NULL)");
      const projectNotes = count('notes', "AND superseded_by IS NULL AND scope LIKE 'proj:%'");

      // Project overview: every project layer with what it actually holds. Notes
      // are model-written conclusions; transcripts are captured automatically, so
      // a project can have transcripts and no notes — the panel must show that.
      const projects = new Map();
      const bump = (scope, field, n, lastAt) => {
        const entry = projects.get(scope) ?? { scope, notes: 0, facts: 0, chunks: 0, lastAt: 0 };
        entry[field] = Number(n);
        entry.lastAt = Math.max(entry.lastAt, Number(lastAt ?? 0));
        projects.set(scope, entry);
      };
      for (const row of s.db.prepare(
        "SELECT scope, COUNT(*) AS n, MAX(ts) AS last FROM notes WHERE deleted_at IS NULL AND superseded_by IS NULL AND scope LIKE 'proj:%' GROUP BY scope"
      ).all()) bump(row.scope, 'notes', row.n, row.last);
      for (const row of s.db.prepare(
        "SELECT scope, COUNT(*) AS n, MAX(valid_from) AS last FROM facts WHERE deleted_at IS NULL AND valid_to IS NULL AND scope LIKE 'proj:%' GROUP BY scope"
      ).all()) bump(row.scope, 'facts', row.n, row.last);
      for (const row of s.db.prepare(
        "SELECT scope, COUNT(*) AS n, MAX(ts) AS last FROM chunks WHERE deleted_at IS NULL AND scope LIKE 'proj:%' GROUP BY scope"
      ).all()) bump(row.scope, 'chunks', row.n, row.last);

      // Exact project view also lists its recent transcripts, so captured-but-not-
      // summarized work is visible instead of an empty list.
      let chunks = [];
      if (scopeFilter !== 'all' && scopeFilter !== 'global' && scopeFilter !== 'project') {
        chunks = s.db.prepare(`
          SELECT id, ts, role, source, text FROM chunks
          WHERE deleted_at IS NULL AND scope = ?
          ORDER BY ts DESC LIMIT 20
        `).all(scopeFilter).map(row => ({
          kind: 'chunk',
          id: Number(row.id),
          ts: Number(row.ts),
          role: row.role,
          source: row.source ?? '',
          text: String(row.text).slice(0, 300),
        }));
      }

      // Workspaces DSH knows but that hold no memories yet still belong in the
      // overview. Their folder names cannot be reversed into an exact scope key,
      // so they are listed as read-only placeholders (`empty: true`, no scope).
      const existingLabels = [...projects.keys()]
        .map(key => normalizeWorkspaceLabel(String(key).replace(/^proj:/, '').split('#')[0]))
        .filter(Boolean);
      const seenLabels = new Set(existingLabels);
      let emptyProjects = 0;
      for (const workspace of discoverWorkspaces()) {
        const normalized = workspace.normalized;
        if (!normalized || seenLabels.has(normalized)) continue;
        if (existingLabels.some(label => normalized.endsWith(label) || label.endsWith(normalized))) continue;
        seenLabels.add(normalized);
        projects.set(`workspace:${workspace.dir}`, {
          scope: '', label: workspace.label, notes: 0, facts: 0, chunks: 0, lastAt: 0, empty: true,
        });
        emptyProjects += 1;
      }

      const projectRows = [...projects.values()].sort((a, b) =>
        (b.lastAt - a.lastAt) || String(a.label ?? a.scope).localeCompare(String(b.label ?? b.scope)));

      return json(res, 200, {
        ok: true,
        db: path.basename(DB_FILE),
        fts: s.ftsMode,
        schema: s.schemaVersion,
        index: s.fts,
        page: {
          limit,
          offset,
          scope: scopeFilter,
          totalNotes,
          totalFacts,
          hasMoreNotes: offset + notes.length < totalNotes,
          hasMoreFacts: offset + facts.length < totalFacts,
        },
        stats: {
          notes: count('notes'),
          facts: count('facts', 'AND valid_to IS NULL'),
          chunks: count('chunks'),
          globalNotes,
          projectNotes,
          contested: count('notes', 'AND contested = 1'),
          verified: count('notes', 'AND verification IS NOT NULL'),
        },
        projects: projectRows,
        projectTotal: projectRows.length,
        projectEmpty: emptyProjects,
        chunks,
        notes, facts,
      });
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/graph',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { ok: false });
      const s = openStore();
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const requested = String(url.searchParams.get('scope') ?? 'global').trim();

      // One map per layer: the global map and one per project. `all` merges them.
      const clause = requested === 'all'
        ? { sql: '', params: [] }
        : requested === 'global'
          ? { sql: "AND (scope = 'global' OR scope IS NULL)", params: [] }
          : { sql: 'AND scope = ?', params: [requested] };

      const nodes = new Map();
      const links = [];
      const addNode = (id, kind, label, weight, scope) => {
        if (!nodes.has(id)) nodes.set(id, { id, kind, label, weight, scope });
        return nodes.get(id);
      };

      // Facts become stars joined by their relation; scoped so a project map only
      // ever shows its own constellation.
      const facts = s.db.prepare(`
        SELECT subject, relation, object, scope FROM facts
        WHERE deleted_at IS NULL AND valid_to IS NULL ${clause.sql}
        ORDER BY confidence DESC, valid_from DESC LIMIT 500
      `).all(...clause.params);
      const degree = new Map();
      for (const fact of facts) {
        for (const name of [fact.subject, fact.object]) {
          if (!name) continue;
          degree.set(name, (degree.get(name) ?? 0) + 1);
        }
      }
      const keep = new Set([...degree.entries()].sort((a, b) => b[1] - a[1]).slice(0, 220).map(([name]) => name));
      for (const name of keep) {
        addNode(`e:${name}`, 'entity', name, Math.min(1, 0.35 + (degree.get(name) ?? 0) / 12), 'global');
      }
      const seen = new Set();
      for (const fact of facts) {
        if (!keep.has(fact.subject) || !keep.has(fact.object)) continue;
        const key = `${fact.subject}|${fact.relation}|${fact.object}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ source: `e:${fact.subject}`, target: `e:${fact.object}`, rel: fact.relation });
      }

      // Notes are bright stars attached to the entities they mention.
      const notes = s.db.prepare(`
        SELECT id, text, scope, importance FROM notes
        WHERE deleted_at IS NULL AND superseded_by IS NULL ${clause.sql}
        ORDER BY importance DESC, ts DESC LIMIT 120
      `).all(...clause.params);
      for (const note of notes) {
        const id = `n:${note.id}`;
        addNode(id, 'note', String(note.text).slice(0, 30), Number(note.importance ?? 0.5), note.scope ?? 'global');
        for (const name of keep) {
          if (String(note.text).includes(name)) links.push({ source: id, target: `e:${name}`, rel: 'mentions' });
        }
      }

      // Layer directory for the map switcher.
      const scopes = new Map();
      const bump = (key, field, count) => {
        const entry = scopes.get(key) ?? { key, facts: 0, notes: 0 };
        entry[field] = Number(count);
        scopes.set(key, entry);
      };
      for (const row of s.db.prepare(
        "SELECT COALESCE(scope, 'global') AS scope, COUNT(*) AS n FROM facts WHERE deleted_at IS NULL AND valid_to IS NULL GROUP BY COALESCE(scope, 'global')"
      ).all()) bump(row.scope, 'facts', row.n);
      for (const row of s.db.prepare(
        "SELECT COALESCE(scope, 'global') AS scope, COUNT(*) AS n FROM notes WHERE deleted_at IS NULL GROUP BY COALESCE(scope, 'global')"
      ).all()) bump(row.scope, 'notes', row.n);

      const directory = [...scopes.values()]
        .map(entry => ({
          key: entry.key,
          label: entry.key === 'global' ? 'global' : String(entry.key).replace(/^proj:/, '').split('#')[0],
          facts: entry.facts,
          notes: entry.notes,
        }))
        .sort((a, b) => (a.key === 'global' ? -1 : b.key === 'global' ? 1 : (b.facts + b.notes) - (a.facts + a.notes)));

      return json(res, 200, {
        ok: true,
        scope: requested,
        scopes: directory,
        nodes: [...nodes.values()],
        links,
      });
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/node',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { ok: false });
      const s = openStore();
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const node = String(url.searchParams.get('node') ?? '').trim();
      const requestedScope = String(url.searchParams.get('scope') ?? '').trim();
      const scope = requestedScope === 'all' ? null : (requestedScope || SCOPE_GLOBAL);
      const noteFilter = scope ? scopeClause('scope', scope, false) : { sql: '', params: [] };
      const factFilter = scope ? scopeClause('scope', scope) : { sql: '', params: [] };

      if (node.startsWith('n:')) {
        const id = Number(node.slice(2));
        if (!Number.isFinite(id)) return json(res, 400, { ok: false });
        const row = s.db.prepare(`
          SELECT * FROM notes
          WHERE id = ? AND deleted_at IS NULL AND superseded_by IS NULL ${noteFilter.sql}
        `).get(id, ...noteFilter.params);
        if (!row) return json(res, 404, { ok: false });
        return json(res, 200, {
          ok: true,
          node: {
            kind: 'note',
            id: row.id,
            text: row.text,
            scope: row.scope ?? 'global',
            importance: row.importance ?? 0.5,
            source: row.source ?? '',
            ts: row.ts ?? null,
            contested: Boolean(row.contested),
            verification: row.verification ?? null,
          },
        });
      }

      if (node.startsWith('e:')) {
        const name = node.slice(2).trim();
        if (!name) return json(res, 400, { ok: false });
        const facts = s.db.prepare(`
          SELECT subject, relation, object, scope, confidence, valid_from FROM facts
          WHERE deleted_at IS NULL AND valid_to IS NULL AND (subject = ? OR object = ?)
          ${factFilter.sql}
          ORDER BY confidence DESC, valid_from DESC LIMIT 40
        `).all(name, name, ...factFilter.params);
        return json(res, 200, { ok: true, node: { kind: 'entity', name, facts } });
      }

      return json(res, 400, { ok: false });
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/status',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { ok: false });
      const s = openStore();
      const count = table => Number(s.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL`).get().n);
      return json(res, 200, {
        ok: true,
        autoRecall: autoRecallEnabled(),
        lastInjection,
        lastJudge,
        embedding: {
          kind: backendConfig().kind,
          dim: activeVectorDim(),
          pending: pendingVectors.size,
        },
        stats: {
          notes: count('notes'),
          facts: Number(s.db.prepare('SELECT COUNT(*) AS n FROM facts WHERE deleted_at IS NULL AND valid_to IS NULL').get().n),
          chunks: count('chunks'),
          contested: Number(s.db.prepare('SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NULL AND contested = 1').get().n),
          verified: Number(s.db.prepare('SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NULL AND verification IS NOT NULL').get().n),
        },
      });
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/search',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { ok: false });
      const s = openStore();
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const query = url.searchParams.get('q') ?? '';
      if (!queryTerms(query).length) return json(res, 200, { ok: true, hits: [] });
      const limit = Math.min(60, Math.max(1, Number(url.searchParams.get('limit') ?? 30)));
      const requestedScope = String(url.searchParams.get('scope') ?? '').trim();
      // A bare HTTP request gets global only. "all" is an explicit audit choice;
      // project keys include that project plus global.
      const scope = requestedScope === 'all' ? null : (requestedScope || SCOPE_GLOBAL);
      const result = await runSearch(s, query, limit, scope);
      return json(res, 200, { ok: true, scope: requestedScope || SCOPE_GLOBAL, hits: result.hits });
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/forget',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { ok: false });
      const s = openStore();
      const method = String(req.method ?? 'GET').toUpperCase();
      if (method !== 'POST') return json(res, 405, { ok: false, error: 'forget requires POST' });
      if (!mutationAllowed(req)) return json(res, 403, { ok: false, error: 'forbidden' });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      let kind = url.searchParams.get('kind') ?? '';
      let id = Number(url.searchParams.get('id') ?? 0);
      // The host server may pre-consume the request stream, so the body is only a
      // fallback: parameters travel in the query string.
      if (!kind || !id) {
        const body = await readJsonBody(req);
        kind = String(body.kind ?? kind);
        id = Number(body.id ?? id);
      }
      const table = { note: 'notes', fact: 'facts', chunk: 'chunks' }[kind];
      if (!table || !id) {
        return json(res, 400, { ok: false, error: 'kind and id required' });
      }
      const forgotten = forgetMemory(s, kind, id);
      invalidateProfile();
      return json(res, 200, { ok: true, forgotten });
    },
  });

  return () => {
    for (const dispose of disposers) {
      try { dispose(); } catch { /* already gone */ }
    }
  };
}

export function apply(ctx) {
  ctx.effect(() => {
    const disposers = defineTools(ctx);
    return () => {
      for (const dispose of disposers) {
        try { dispose(); } catch { /* already gone */ }
      }
    };
  }, 'omni-memory: tools');

  ctx.effect(() => {
    const cleanup = registerRoutes(ctx);
    return () => { try { cleanup?.(); } catch { /* ignore */ } };
  }, 'omni-memory: routes');

  // Transcript capture: post-commit feed only. Reading a Session projection or
  // preparing one here would blank the live conversation.
  ctx.effect(() => {
    if (typeof ctx.on !== 'function') return undefined;
    const dispose = ctx.on('session/event', (session, event) => captureEvent(session, event));
    return () => { try { dispose?.(); } catch { /* ignore */ } };
  }, 'omni-memory: capture');

  // Auto-recall input: capture the user message as it is claimed into a turn, so
  // the synchronous prompt provider has something to recall against.
  ctx.effect(() => {
    if (typeof ctx.on !== 'function') return undefined;
    const dispose = ctx.on('agent/inbox/claimed', payload => {
      rememberUserMessage(payload?.agent, payload?.message);
    });
    return () => { try { dispose?.(); } catch { /* ignore */ } };
  }, 'omni-memory: auto recall');

  // Always-injected profile: a small, cached block of the strongest notes, plus
  // the precomputed recall for this request when the switch is on.
  ctx.effect(() => {
    let prompt;
    try {
      prompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : ctx.systemPrompt;
    } catch {
      prompt = undefined;
    }
    if (!prompt || typeof prompt.section !== 'function') return undefined;
    const dispose = prompt.section({
      name: 'omni-memory',
      order: 600,
      text: assemblyContext => {
        const project = projectForScope(assemblyContext?.scope);
        const lines = [];
        const body = cachedProfile(project);
        if (body) {
          lines.push('Long-term memory from earlier sessions. It may be stale; confirm with memory_search before relying on it for a destructive or irreversible action.');
          lines.push(body);
        }
        if (project) {
          lines.push(`Current project scope: ${project}. Pass it as \`scope\` to memory_write/memory_search for project-only knowledge; omit it for cross-project rules.`);
        }
        const recalled = recallFor(assemblyContext?.scope);
        const safeHits = (recalled?.hits ?? []).filter(hit => !hit.contested && !hit.superseded_by);
        if (safeHits.length) {
          lines.push('Recalled for this request (ranked by the same hybrid search; verify before acting on it):');
          for (const hit of safeHits.slice(0, 3)) {
            lines.push(`- [${hit.kind}#${hit.id}] ${String(hit.text).replace(/\s+/g, ' ').slice(0, 180)}`);
          }
        }
        // The budget applies to the whole injected section, including the header,
        // project line and recalled hits -- not just the profile body.
        let text = lines.join('\n');
        if (text.length > PROFILE_BUDGET) {
          const withoutRecall = lines.filter(line => !line.startsWith('Recalled for this request') && !line.startsWith('- ['));
          text = withoutRecall.join('\n').slice(0, PROFILE_BUDGET);
        }
        lastInjection = {
          at: now(),
          chars: text.length,
          recall: safeHits.length,
          auto: autoRecallEnabled(),
          project: project ?? SCOPE_GLOBAL,
          // Diagnostics: whether the assembly handed us a usable scope id at all.
          scopeId: assemblyContext?.scope?.id ? String(assemblyContext.scope.id).slice(0, 12) : null,
        };
        return text;
      },
    });
    return () => { try { dispose?.(); } catch { /* ignore */ } };
  }, 'omni-memory: prompt section');

  // Optional offline consolidation. Off by default: a background verifier that
  // costs model calls or disk churn must be an explicit choice.
  ctx.effect(() => {
    const intervalMs = Number(process.env.OMNI_DREAM_INTERVAL_MS ?? 0);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0 || typeof setInterval !== 'function') return undefined;
    const timer = setInterval(() => {
      try { dreamRun(openStore(), true); } catch { /* never break the host */ }
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }, 'omni-memory: dream timer');

  ctx.effect(() => () => {
    try { store?.db?.close(); } catch { /* ignore */ }
    store = undefined;
  }, 'omni-memory: store');
}

