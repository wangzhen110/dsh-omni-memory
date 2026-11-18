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
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
          const oldScope = item.scope ?? SCOPE_GLOBAL;
          s.db.prepare(`UPDATE ${item.table} SET scope = ? WHERE id = ?`).run(verdict, Number(item.id));
          if (item.kind === 'fact') {
            const fact = s.db.prepare('SELECT subject, relation, object FROM facts WHERE id = ?').get(Number(item.id));
            if (fact) {
              s.db.prepare(`
                UPDATE edges SET scope = ?
                WHERE src = ? AND rel = ? AND dst = ? AND valid_to IS NULL
                  AND (scope = ? OR scope IS NULL)
              `).run(verdict, fact.subject, fact.relation, String(fact.object ?? ''), oldScope);
            }
          }
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
      deleted_at INTEGER,
      problem_key TEXT,
      solution_status TEXT,
      solution_verified_at INTEGER,
      reuse_count INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER
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

export const SCHEMA_VERSION = 11;
let hostCtx = null;

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
  // v8: multi-valued relations. Existing facts stay single-valued.
  db => {
    addColumn(db, 'facts', 'cardinality', "TEXT NOT NULL DEFAULT 'single'");
    db.exec(`
      CREATE TABLE IF NOT EXISTS relations (
        name TEXT PRIMARY KEY,
        cardinality TEXT NOT NULL DEFAULT 'single',
        aliases TEXT,
        updated_at INTEGER
      );
    `);
  },
  // v9: entity aliases. Facts are canonicalised at write time; aliases merge
  // existing rows only when explicitly requested by memory_link_entity.
  db => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS entity_aliases (
        alias TEXT PRIMARY KEY,
        canonical TEXT NOT NULL,
        updated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS entity_aliases_canonical ON entity_aliases(canonical);
    `);
  },
  // v10: user-defined persona settings (personality, habits, preferences...).
  db => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS persona (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER
      );
    `);
  },
  // v11: turn notes into problem-solving memory. `verification` remains the
  // transcript-coverage verdict from dreaming; `solution_status` is the real-world
  // outcome (verified / unverified / failed / expired).
  db => {
    addColumn(db, 'notes', 'problem_key', 'TEXT');
    addColumn(db, 'notes', 'solution_status', 'TEXT');
    addColumn(db, 'notes', 'solution_verified_at', 'INTEGER');
    addColumn(db, 'notes', 'reuse_count', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'notes', 'last_used_at', 'INTEGER');
    db.exec(`
      CREATE INDEX IF NOT EXISTS notes_problem_key ON notes(problem_key);
      CREATE INDEX IF NOT EXISTS notes_solution_status ON notes(solution_status);
    `);
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
  // Repair path: never trust the version marker alone. A database whose marker
  // is current but lacks a table/column is repaired in place; this is what a
  // migration inserted at the wrong array index used to produce.
  if (SCHEMA_VERSION >= 8 && !columnExists(db, 'facts', 'cardinality')) {
    addColumn(db, 'facts', 'cardinality', "TEXT NOT NULL DEFAULT 'single'");
    db.exec(`
      CREATE TABLE IF NOT EXISTS relations (
        name TEXT PRIMARY KEY,
        cardinality TEXT NOT NULL DEFAULT 'single',
        aliases TEXT,
        updated_at INTEGER
      );
    `);
  }
  if (SCHEMA_VERSION >= 9) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS entity_aliases (
        alias TEXT PRIMARY KEY,
        canonical TEXT NOT NULL,
        updated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS entity_aliases_canonical ON entity_aliases(canonical);
    `);
  }
  if (SCHEMA_VERSION >= 10) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS persona (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER
      );
    `);
  }
  if (SCHEMA_VERSION >= 11) {
    addColumn(db, 'notes', 'problem_key', 'TEXT');
    addColumn(db, 'notes', 'solution_status', 'TEXT');
    addColumn(db, 'notes', 'solution_verified_at', 'INTEGER');
    addColumn(db, 'notes', 'reuse_count', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'notes', 'last_used_at', 'INTEGER');
    db.exec(`
      CREATE INDEX IF NOT EXISTS notes_problem_key ON notes(problem_key);
      CREATE INDEX IF NOT EXISTS notes_solution_status ON notes(solution_status);
    `);
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
  const report = { scanned: 0, remaining: false };
  try {
    if (!options.force && metaGet(db, 'bigrams_version') === String(SCHEMA_VERSION)) return report;
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
      report.scanned += rows.length;
      cursor = Number(rows[rows.length - 1].id);
      metaSet(db, cursorKey, cursor);
      if (rows.length >= limit) remaining = true;
    }
    if (!remaining) metaSet(db, 'bigrams_version', SCHEMA_VERSION);
    report.remaining = remaining;
  } catch { /* backfill is best effort */ }
  return report;
}

/**
 * Full rebuild of the CJK bigram index.
 *
 * Opening a large legacy database only backfills one batch per layer, so a big
 * store needed many restarts before 2-character search was complete. This walks
 * the whole corpus in batches inside one call; it is explicit (never on open)
 * because it rewrites a derived index and can take a while on a large store.
 */
function reindexBigrams(s, options = {}) {
  const { db } = s;
  const limit = Math.max(1000, Math.min(50_000, Number(options.limit ?? BIGRAM_BACKFILL_BATCH)));
  transaction(db, () => {
    db.exec('DELETE FROM bigrams');
    for (const layer of ['note', 'fact', 'chunk']) metaSet(db, `bigrams_cursor_${layer}`, 0);
    metaSet(db, 'bigrams_version', '0');
  });
  let scanned = 0;
  let passes = 0;
  let report = { remaining: true, scanned: 0 };
  while (report.remaining && passes < 10_000) {
    report = backfillBigrams(db, { limit });
    scanned += report.scanned;
    passes += 1;
    if (!report.scanned) break;
  }
  return { scanned, passes, done: !report.remaining };
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

function backfillVectors(db, options = {}) {
  if (backendConfig().kind !== 'hashed') return; // remote rows are queued on demand
  const limit = Math.max(0, Number(options.limit ?? 0));
  let remaining = limit || Infinity;
  const jobs = [
    ['note', 'notes', 'text'],
    ['fact', 'facts', 'text'],
    ['chunk', 'chunks', 'text'],
  ];
  for (const [kind, table, column] of jobs) {
    if (remaining <= 0) break;
    try {
      const sql = `
        SELECT t.id AS id, t.${column} AS text
        FROM ${table} t
        WHERE t.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM vectors v
            WHERE v.kind = ? AND v.owner_id = t.id AND v.dim = ?
          )
        ${limit ? 'LIMIT ?' : ''}
      `;
      const rows = limit
        ? db.prepare(sql).all(kind, DIM, Number(remaining))
        : db.prepare(sql).all(kind, DIM);
      for (const row of rows) {
        const vector = embedText(row.text);
        db.prepare('INSERT OR REPLACE INTO vectors(kind, owner_id, dim, vec) VALUES (?, ?, ?, ?)')
          .run(kind, Number(row.id), DIM, toBlob(vector));
      }
      if (limit) remaining -= rows.length;
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

const EXPORT_FORMAT = 'omni-memory-backup';
const EXPORT_VERSION = 1;

/** Build one portable snapshot of the store. Vectors are derived and excluded. */
function snapshotStore(s, options = {}) {
  const audit = options.audit !== false;
  const notesWhere = audit ? '' : 'WHERE deleted_at IS NULL AND superseded_by IS NULL';
  const factsWhere = audit ? '' : 'WHERE deleted_at IS NULL AND valid_to IS NULL';
  const chunksWhere = audit ? '' : 'WHERE deleted_at IS NULL';
  const edgesWhere = audit ? '' : 'WHERE valid_to IS NULL';
  const notes = s.db.prepare(`SELECT * FROM notes ${notesWhere} ORDER BY id`).all();
  const facts = s.db.prepare(`SELECT * FROM facts ${factsWhere} ORDER BY id`).all();
  const chunks = s.db.prepare(`SELECT * FROM chunks ${chunksWhere} ORDER BY id`).all();
  const edges = s.db.prepare(`SELECT * FROM edges ${edgesWhere} ORDER BY id`).all();
  const entities = s.db.prepare('SELECT name FROM entities ORDER BY name').all().map(row => row.name);
  const relations = s.db.prepare('SELECT name, cardinality, aliases, updated_at FROM relations ORDER BY name').all();
  const entityAliases = s.db.prepare('SELECT alias, canonical, updated_at FROM entity_aliases ORDER BY alias').all();
  const persona = s.db.prepare('SELECT key, value, updated_at FROM persona ORDER BY key').all();
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now(),
    schema: SCHEMA_VERSION,
    source: path.basename(DB_FILE),
    counts: {
      notes: notes.length, facts: facts.length, chunks: chunks.length,
      edges: edges.length, entities: entities.length,
      relations: relations.length, entityAliases: entityAliases.length, persona: persona.length,
    },
    notes, facts, chunks, edges, entities, relations, entityAliases, persona,
  };
}

function exportBackup(s, options = {}) {
  const snapshot = snapshotStore(s, options);
  const target = String(options.path ?? '').trim()
    || path.join(DB_DIR, `omni-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return { path: target, counts: snapshot.counts, audit: options.audit !== false };
}

function importBackup(s, options = {}) {
  const file = String(options.path ?? '').trim();
  if (!file) throw new Error('path is required');
  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read backup: ${String(error?.message ?? error)}`);
  }
  return mergeSnapshot(s, snapshot, options);
}

/**
 * Merge a snapshot into the live store.
 *
 * Safe default is a dry run: import touches every table, so the caller has to
 * pass dryRun=false explicitly. Rows are matched by natural identity (text, fact
 * triple, chunk hash, edge triple) rather than by id; a note's `superseded_by`
 * pointer is remapped when ids are reassigned. Vectors are rebuilt, never imported.
 */
function mergeSnapshot(s, snapshot, options = {}) {
  if (!snapshot || snapshot.format !== EXPORT_FORMAT) throw new Error('not an omni-memory backup');
  if (Number(snapshot.version) > EXPORT_VERSION) throw new Error('backup was written by a newer version');
  const dryRun = options.dryRun !== false;
  const stats = {
    notes: 0, facts: 0, chunks: 0, edges: 0, entities: 0,
    relations: 0, entityAliases: 0, persona: 0, skipped: 0, dryRun,
  };
  const plan = { notes: [], facts: [], chunks: [], edges: [], entities: [], relations: [], entityAliases: [], persona: [] };

  const noteExists = s.db.prepare('SELECT id FROM notes WHERE scope = ? AND text = ? AND superseded_by IS NULL');
  const factExists = s.db.prepare('SELECT id FROM facts WHERE subject = ? AND relation = ? AND object = ? AND scope = ?');
  const chunkExists = s.db.prepare("SELECT id FROM chunks WHERE hash = ? AND IFNULL(scope, 'global') = IFNULL(?, 'global')");
  const edgeExists = s.db.prepare("SELECT id FROM edges WHERE src = ? AND rel = ? AND dst = ? AND IFNULL(scope, 'global') = IFNULL(?, 'global')");

  for (const note of Array.isArray(snapshot.notes) ? snapshot.notes : []) {
    if (!note?.text) { stats.skipped += 1; continue; }
    if (noteExists.get(note.scope ?? SCOPE_GLOBAL, note.text)) { stats.skipped += 1; continue; }
    plan.notes.push(note);
  }
  for (const fact of Array.isArray(snapshot.facts) ? snapshot.facts : []) {
    if (!fact?.subject || !fact?.relation) { stats.skipped += 1; continue; }
    if (factExists.get(fact.subject, fact.relation, String(fact.object ?? ''), fact.scope ?? SCOPE_GLOBAL)) {
      stats.skipped += 1;
      continue;
    }
    plan.facts.push(fact);
  }
  for (const chunk of Array.isArray(snapshot.chunks) ? snapshot.chunks : []) {
    if (!chunk?.text) { stats.skipped += 1; continue; }
    const digest = hash(String(chunk.text));
    if (chunkExists.get(digest, chunk.scope ?? 'global')) { stats.skipped += 1; continue; }
    plan.chunks.push(chunk);
  }
  for (const edge of Array.isArray(snapshot.edges) ? snapshot.edges : []) {
    if (!edge?.src || !edge?.rel || !edge?.dst) { stats.skipped += 1; continue; }
    if (edgeExists.get(edge.src, edge.rel, edge.dst, edge.scope ?? SCOPE_GLOBAL)) { stats.skipped += 1; continue; }
    plan.edges.push(edge);
  }
  for (const name of Array.isArray(snapshot.entities) ? snapshot.entities : []) {
    if (!name) { stats.skipped += 1; continue; }
    plan.entities.push(String(name));
  }
  for (const relation of Array.isArray(snapshot.relations) ? snapshot.relations : []) {
    const name = String(relation?.name ?? '').trim();
    if (!name) { stats.skipped += 1; continue; }
    plan.relations.push({ ...relation, name });
  }
  for (const alias of Array.isArray(snapshot.entityAliases) ? snapshot.entityAliases : (Array.isArray(snapshot.aliases) ? snapshot.aliases : [])) {
    const name = String(alias?.alias ?? '').trim();
    const canonical = String(alias?.canonical ?? '').trim();
    if (!name || !canonical) { stats.skipped += 1; continue; }
    plan.entityAliases.push({ ...alias, alias: name, canonical });
  }
  const personaRows = Array.isArray(snapshot.persona)
    ? snapshot.persona
    : Object.entries(snapshot.persona ?? {}).map(([key, value]) => ({ key, value }));
  for (const item of personaRows) {
    const key = String(item?.key ?? '').trim();
    const value = String(item?.value ?? '').trim();
    if (!key || !value) { stats.skipped += 1; continue; }
    plan.persona.push({ ...item, key, value });
  }

  stats.notes = plan.notes.length;
  stats.facts = plan.facts.length;
  stats.chunks = plan.chunks.length;
  stats.edges = plan.edges.length;
  stats.entities = plan.entities.length;
  stats.relations = plan.relations.length;
  stats.entityAliases = plan.entityAliases.length;
  stats.persona = plan.persona.length;
  if (dryRun) return stats;

  const idMap = new Map();
  transaction(s.db, () => {
    for (const note of plan.notes) {
      const info = s.db.prepare(`
        INSERT INTO notes(
          ts, scope, text, importance, source, revision, superseded_by, contested, deleted_at,
          verification, verified_at, evidence, problem_key, solution_status,
          solution_verified_at, reuse_count, last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        Number(note.ts ?? now()), note.scope ?? SCOPE_GLOBAL, String(note.text),
        Number(note.importance ?? 0.5), note.source ?? null, Number(note.revision ?? 1),
        note.superseded_by ?? null, Number(note.contested ?? 0), note.deleted_at ?? null,
        note.verification ?? null, note.verified_at ?? null, note.evidence ?? null,
        note.problem_key ?? note.problemKey ?? null,
        note.solution_status ?? note.solutionStatus ?? null,
        note.solution_verified_at ?? note.solutionVerifiedAt ?? null,
        Number(note.reuse_count ?? note.reuseCount ?? 0),
        note.last_used_at ?? note.lastUsedAt ?? null,
      );
      const newId = Number(info.lastInsertRowid);
      idMap.set(Number(note.id), newId);
      if (s.fts.notes) {
        try { s.db.prepare('INSERT INTO notes_fts(rowid, text) VALUES (?, ?)').run(newId, String(note.text)); } catch { /* duplicate */ }
      }
      indexBigrams(s.db, 'note', newId, String(note.text));
      upsertVector(s, 'note', newId, String(note.text));
    }
    // Remap note lineage pointers to the ids assigned in this database.
    for (const note of plan.notes) {
      const replacement = Number(note.superseded_by ?? 0);
      if (!replacement) continue;
      const newId = idMap.get(Number(note.id));
      const target = idMap.get(replacement) ?? replacement;
      if (newId) s.db.prepare('UPDATE notes SET superseded_by = ? WHERE id = ?').run(target, newId);
    }
    for (const fact of plan.facts) {
      const info = s.db.prepare(`
        INSERT INTO facts(subject, relation, object, text, valid_from, valid_to, recorded_at, confidence, source, contested, scope, deleted_at, cardinality)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        String(fact.subject), String(fact.relation), String(fact.object ?? ''),
        String(fact.text ?? `${fact.subject} ${fact.relation} ${fact.object ?? ''}`),
        Number(fact.valid_from ?? now()), fact.valid_to ?? null, fact.recorded_at ?? null,
        Number(fact.confidence ?? 0.7), fact.source ?? null, Number(fact.contested ?? 0),
        fact.scope ?? SCOPE_GLOBAL, fact.deleted_at ?? null, fact.cardinality === 'multi' ? 'multi' : 'single',
      );
      const newId = Number(info.lastInsertRowid);
      if (s.fts.facts) {
        try { s.db.prepare('INSERT INTO facts_fts(rowid, text) VALUES (?, ?)').run(newId, String(fact.text ?? '')); } catch { /* duplicate */ }
      }
      indexBigrams(s.db, 'fact', newId, String(fact.text ?? `${fact.subject} ${fact.relation} ${fact.object ?? ''}`));
      upsertVector(s, 'fact', newId, String(fact.text ?? `${fact.subject} ${fact.relation} ${fact.object ?? ''}`));
    }
    for (const chunk of plan.chunks) {
      const text = String(chunk.text);
      const info = s.db.prepare(`
        INSERT INTO chunks(ts, session_id, role, text, hash, source, importance, scope, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        Number(chunk.ts ?? now()), chunk.session_id ?? null, chunk.role ?? 'note', text,
        hash(text), chunk.source ?? null, Number(chunk.importance ?? 0.5), chunk.scope ?? null,
        chunk.deleted_at ?? null,
      );
      const newId = Number(info.lastInsertRowid);
      if (s.fts.chunks) {
        try { s.db.prepare('INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)').run(newId, text); } catch { /* duplicate */ }
      }
      indexBigrams(s.db, 'chunk', newId, text);
      upsertVector(s, 'chunk', newId, text);
    }
    for (const edge of plan.edges) {
      s.db.prepare(`
        INSERT INTO edges(src, rel, dst, valid_from, valid_to, scope, source)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        String(edge.src), String(edge.rel), String(edge.dst),
        Number(edge.valid_from ?? now()), edge.valid_to ?? null,
        edge.scope ?? null, edge.source ?? null,
      );
    }
    for (const name of plan.entities) s.db.prepare('INSERT OR IGNORE INTO entities(name) VALUES (?)').run(name);
    for (const relation of plan.relations) {
      s.db.prepare(`
        INSERT INTO relations(name, cardinality, aliases, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          cardinality = excluded.cardinality,
          aliases = excluded.aliases,
          updated_at = excluded.updated_at
      `).run(
        String(relation.name), String(relation.cardinality ?? 'single'),
        relation.aliases === null || relation.aliases === undefined ? null : String(relation.aliases),
        Number(relation.updated_at ?? now()),
      );
    }
    for (const alias of plan.entityAliases) {
      s.db.prepare(`
        INSERT INTO entity_aliases(alias, canonical, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(alias) DO UPDATE SET
          canonical = excluded.canonical,
          updated_at = excluded.updated_at
      `).run(String(alias.alias), String(alias.canonical), Number(alias.updated_at ?? now()));
    }
    for (const setting of plan.persona) {
      s.db.prepare(`
        INSERT INTO persona(key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `).run(String(setting.key), String(setting.value), Number(setting.updated_at ?? now()));
    }
  });
  entityCache = { names: [], at: 0 };
  invalidateProfile();
  return stats;
}

/** Revive one tombstoned row and restore its derived indexes. */
function restoreMemory(s, kind, id) {
  const table = { note: 'notes', fact: 'facts', chunk: 'chunks' }[String(kind)];
  if (!table) throw new Error('kind must be note, fact or chunk');
  const result = transaction(s.db, () => {
    const row = s.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(id));
    if (!row) return { restored: false, reason: 'not found' };
    if (!row.deleted_at) return { restored: false, reason: 'not tombstoned' };
    if (table === 'chunks') {
      // The unique index is (hash, scope) among active rows. Restoring an old
      // copy while a newer active copy exists would abort the whole transaction
      // with a raw UNIQUE error; return a structured conflict instead.
      const active = s.db.prepare(`
        SELECT id FROM chunks
        WHERE hash = ? AND IFNULL(scope, 'global') = IFNULL(?, 'global')
          AND deleted_at IS NULL AND id <> ?
      `).get(row.hash, row.scope, Number(id));
      if (active) return { restored: false, reason: 'active duplicate', activeId: Number(active.id) };
    }
    s.db.prepare(`UPDATE ${table} SET deleted_at = NULL WHERE id = ?`).run(Number(id));
    if (table === 'notes') {
      if (s.fts.notes) {
        try { s.db.prepare('INSERT INTO notes_fts(rowid, text) VALUES (?, ?)').run(Number(id), row.text); } catch { /* already indexed */ }
      }
      indexBigrams(s.db, 'note', Number(id), row.text);
      upsertVector(s, 'note', Number(id), row.text);
    } else if (table === 'facts') {
      const text = String(row.text ?? `${row.subject} ${row.relation} ${row.object}`);
      if (s.fts.facts) {
        try { s.db.prepare('INSERT INTO facts_fts(rowid, text) VALUES (?, ?)').run(Number(id), text); } catch { /* already indexed */ }
      }
      indexBigrams(s.db, 'fact', Number(id), text);
      upsertVector(s, 'fact', Number(id), text);
      const edge = s.db.prepare(`
        SELECT id FROM edges WHERE src = ? AND rel = ? AND dst = ? AND valid_to IS NULL
          AND (scope = ? OR scope IS NULL)
      `).get(row.subject, row.relation, String(row.object ?? ''), row.scope ?? SCOPE_GLOBAL);
      if (!edge) {
        s.db.prepare('INSERT INTO edges(src, rel, dst, valid_from, scope, source) VALUES (?, ?, ?, ?, ?, ?)')
          .run(row.subject, row.relation, String(row.object ?? ''), Number(row.valid_from ?? now()), row.scope ?? SCOPE_GLOBAL, row.source ?? null);
      }
    } else {
      if (s.fts.chunks) {
        try { s.db.prepare('INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)').run(Number(id), row.text); } catch { /* already indexed */ }
      }
      indexBigrams(s.db, 'chunk', Number(id), row.text);
      upsertVector(s, 'chunk', Number(id), row.text);
    }
    return { restored: true };
  });
  if (result.restored) invalidateProfile();
  return result;
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
  // The panel's "project" layer means every project row, excluding global. It is
  // not the same as one exact project key (which is a project + global view).
  if (scope === 'project') return { sql: `AND ${column} LIKE 'proj:%'`, params: [] };
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
/**
 * Bounded lexical candidates.
 *
 * `ORDER BY bm25(...)` forces SQLite to materialise the whole match list before
 * returning the first row: at 1M notes one common term cost ~600ms even though
 * the same MATCH without ranking answers in 0.1ms. Lexical retrieval is now two
 * stages: bounded candidate generation (recent-window LIKE, unranked FTS sample,
 * bigram index capped by owner id) followed by JS scoring. Window size is
 * configurable; the window never replaces exact matches, it adds recent ones.
 */
const SEARCH_WINDOW = Math.max(1000, Number(process.env.OMNI_SEARCH_WINDOW ?? 20000));
const FTS_SAMPLE = 120;
const BIGRAM_SAMPLE = 200;

/** Recent-window substring scan: bounded by window size, recency biased. */
function recentWindowRows(db, table, terms, columns, filter, limit, extra = '') {
  const clause = likeClause(columns, terms);
  try {
    const max = Number(db.prepare(`SELECT MAX(id) AS n FROM ${table}`).get()?.n ?? 0);
    if (!max) return [];
    return db.prepare(`
      SELECT * FROM ${table}
      WHERE id > ? AND deleted_at IS NULL ${extra} AND ${clause.sql} ${filter.sql}
      ORDER BY id DESC LIMIT ?
    `).all(max - SEARCH_WINDOW, ...clause.params, ...filter.params, Math.max(limit * 4, 16));
  } catch {
    return [];
  }
}

/**
 * Sample matching rowids only.
 *
 * Joining the FTS table to the source table and filtering *after* the join made
 * LIMIT ineffective whenever the filter rejected the first matches (a project
 * scope can reject almost everything): SQLite then walked the whole doclist.
 * Sampling rowids first bounds the cost to the sample size, and scope/active
 * checks happen in JS on the fetched rows.
 */
function ftsRowIds(db, ftsTable, term, limit) {
  const quoted = `"${String(term).replaceAll('"', '""')}"`;
  try {
    return db.prepare(`SELECT rowid FROM ${ftsTable} WHERE ${ftsTable} MATCH ? LIMIT ?`)
      .all(quoted, limit)
      .map(row => Number(row.rowid));
  } catch {
    return [];
  }
}

/** Fetch rows by id with the active-state filter pushed into SQL. */
function rowsByIds(db, table, ids, extraSql = '') {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  try {
    return db.prepare(`SELECT * FROM ${table} WHERE id IN (${placeholders}) ${extraSql}`).all(...ids);
  } catch {
    return [];
  }
}

/** The JS twin of scopeClause for rows fetched by id. */
/** Normalise an entity name so "Deploy" and "deploy" are the same node. */
function normalizeEntity(name) {
  const text = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return text
    .replace(/[\uFF01-\uFF5E]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .toLowerCase()
    .replace(/^[\s"'\u201c\u201d]+|[\s"'\u201c\u201d]+$/g, '')
    .replace(/[。；;，,]+$/g, '');
}

/** Follow the alias chain (bounded) to the canonical entity. */
function canonicalEntity(db, name) {
  let current = normalizeEntity(name);
  if (!current) return current;
  try {
    for (let depth = 0; depth < 5; depth += 1) {
      const row = db.prepare('SELECT canonical FROM entity_aliases WHERE alias = ?').get(current);
      if (!row || row.canonical === current) break;
      current = String(row.canonical);
    }
  } catch { /* registry absent on very old stores */ }
  return current;
}

function linkEntity(s, aliasInput, canonicalInput, options = {}) {
  const alias = normalizeEntity(aliasInput);
  const canonical = canonicalEntity(s.db, canonicalInput);
  if (!alias || !canonical) throw new Error('alias and canonical are required');
  if (alias === canonical) throw new Error('alias and canonical are the same entity');
  const dryRun = options.apply !== true;
  const affectedFacts = Number(s.db.prepare('SELECT COUNT(*) AS n FROM facts WHERE subject = ?').get(alias)?.n ?? 0);
  const affectedEdges = Number(s.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE src = ?").get(alias)?.n ?? 0);
  if (dryRun) return { alias, canonical, affectedFacts, affectedEdges, applied: false };
  transaction(s.db, () => {
    s.db.prepare('INSERT OR REPLACE INTO entity_aliases(alias, canonical, updated_at) VALUES (?, ?, ?)')
      .run(alias, canonical, now());
    s.db.prepare('INSERT OR IGNORE INTO entities(name) VALUES (?)').run(canonical);
    s.db.prepare('UPDATE facts SET subject = ? WHERE subject = ?').run(canonical, alias);
    s.db.prepare('UPDATE edges SET src = ? WHERE src = ?').run(canonical, alias);
    s.db.prepare('DELETE FROM entities WHERE name = ?').run(alias);
  });
  entityCache = { names: [], at: 0 };
  invalidateProfile();
  return { alias, canonical, affectedFacts, affectedEdges, applied: true };
}

function relationCardinality(db, name) {
  try {
    return db.prepare('SELECT cardinality FROM relations WHERE name = ?').get(name)?.cardinality ?? 'single';
  } catch {
    return 'single';
  }
}

function setRelationCardinality(db, name, cardinality) {
  try {
    db.prepare(`
      INSERT INTO relations(name, cardinality, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET cardinality = excluded.cardinality, updated_at = excluded.updated_at
    `).run(name, cardinality, now());
  } catch { /* registry is best effort */ }
}

function scopeAllows(value, scope, nulls = true) {
  if (!scope || scope === 'all') return true;
  if (scope === 'project') return String(value ?? '').startsWith('proj:');
  if (value === scope || value === 'global') return true;
  return nulls && (value === null || value === undefined);
}

const SOLUTION_STATUSES = new Set(['verified', 'unverified', 'failed', 'expired']);

/** Normalize an error signature so the same failure matches across sessions. */
function normalizeProblemKey(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

function solutionStatusOf(value) {
  const status = String(value ?? 'unverified').trim().toLowerCase();
  return SOLUTION_STATUSES.has(status) ? status : 'unverified';
}

/** Prefer proven solutions; keep failed/expired attempts visible but below them. */
function solutionBoost(statusValue, reuseValue = 0) {
  const status = solutionStatusOf(statusValue);
  const reuse = Math.min(0.15, Math.log1p(Math.max(0, Number(reuseValue) || 0)) * 0.05);
  if (status === 'verified') return 0.2 + reuse;
  if (status === 'failed') return -0.2 + reuse;
  if (status === 'expired') return -0.35 + reuse;
  return reuse;
}

/** Fields shared by every note-shaped search hit and API detail response. */
function solutionFields(row) {
  return {
    problemKey: row.problem_key ?? row.problemKey ?? null,
    solutionStatus: solutionStatusOf(row.solution_status ?? row.solutionStatus),
    reuseCount: Number(row.reuse_count ?? row.reuseCount ?? 0),
    lastUsedAt: row.last_used_at ?? row.lastUsedAt ?? null,
    verifiedAt: row.solution_verified_at ?? row.solutionVerifiedAt ?? null,
    verification: row.verification ?? null,
    evidence: row.evidence ?? null,
  };
}

/**
 * Two-character CJK lookup through the bigram index. The inner query walks the
 * (gram, layer, owner_id) index backwards and stops after the sample size, so a
 * gram that appears in every row still costs O(sample) instead of O(rows).
 */
function searchBigrams(s, layer, table, term, limit, filter, extra = '') {
  if (!CJK_BIGRAM.test(term)) return [];
  try {
    return s.db.prepare(`
      SELECT t.* FROM (
        SELECT owner_id FROM bigrams
        WHERE layer = ? AND gram = ?
        ORDER BY owner_id DESC LIMIT ?
      ) b JOIN ${table} t ON t.id = b.owner_id
      WHERE t.deleted_at IS NULL ${extra} ${filter.sql}
      ORDER BY t.id DESC
    `).all(layer, term, Math.max(BIGRAM_SAMPLE, limit * 4), ...filter.params);
  } catch {
    return [];
  }
}

function searchChunks(s, terms, limit, scope) {
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

  const filter = scopeClause('scope', scope);
  for (const row of recentWindowRows(s.db, 'chunks', terms, ['text', 'source'], filter, limit)) push(row, 0.5);
  if (s.fts.chunks) {
    const bigramFilter = scopeClause('t.scope', scope);
    for (const term of terms.slice(0, 5)) {
      if (term.length === 2 && CJK_BIGRAM.test(term)) {
        for (const row of searchBigrams(s, 'chunk', 'chunks', term, limit, bigramFilter)) {
          if (scopeAllows(row.scope, scope)) push(row, 1);
        }
        continue;
      }
      if (term.length < 3) continue;
      const rows = rowsByIds(s.db, 'chunks', ftsRowIds(s.db, 'chunks_fts', term, FTS_SAMPLE), 'AND deleted_at IS NULL');
      for (const row of rows) if (scopeAllows(row.scope, scope)) push(row, 0.8);
    }
  }
  return out;
}

function searchNotes(s, terms, limit, scope, options = {}) {
  if (!terms.length) return [];
  const status = options.status && options.status !== 'all' ? solutionStatusOf(options.status) : null;
  const found = new Map();
  const push = (row, textScore) => {
    if (status && solutionStatusOf(row.solution_status) !== status) return;
    const id = Number(row.id);
    const candidate = {
      kind: 'note',
      id,
      ts: Number(row.ts),
      scope: row.scope,
      source: row.source ?? '',
      revision: Number(row.revision ?? 1),
      contested: Number(row.contested ?? 0) === 1,
      ...solutionFields(row),
      text: String(row.text).slice(0, 400),
      score: 0.6 * Math.max(0.6, textScore, matchRatio(row, ['text'], terms))
        + 0.2 * Number(row.importance ?? 0.5)
        + 0.2 * recencyScore(row.ts)
        + solutionBoost(row.solution_status, row.reuse_count),
    };
    const previous = found.get(id);
    if (!previous || candidate.score > previous.score) found.set(id, candidate);
  };

  const filter = scopeClause('scope', scope, false);
  for (const row of recentWindowRows(s.db, 'notes', terms, ['text'], filter, limit, 'AND superseded_by IS NULL')) {
    push(row, 0.5);
  }
  if (s.fts.notes) {
    const bigramFilter = scopeClause('t.scope', scope, false);
    for (const term of terms.slice(0, 6)) {
      if (term.length === 2 && CJK_BIGRAM.test(term)) {
        for (const row of searchBigrams(s, 'note', 'notes', term, limit, bigramFilter, 'AND t.superseded_by IS NULL')) {
          if (scopeAllows(row.scope, scope, false)) push(row, 1);
        }
        continue;
      }
      if (term.length < 3) continue;
      const rows = rowsByIds(s.db, 'notes', ftsRowIds(s.db, 'notes_fts', term, FTS_SAMPLE), 'AND deleted_at IS NULL AND superseded_by IS NULL');
      for (const row of rows) if (scopeAllows(row.scope, scope, false)) push(row, 0.8);
    }
  }
  return [...found.values()];
}

/** Deterministic lookup for an exact error signature before semantic recall. */
function searchProblemKey(s, problemKey, limit, scope, options = {}) {
  const key = normalizeProblemKey(problemKey);
  if (!key) return [];
  const status = options.status && options.status !== 'all' ? solutionStatusOf(options.status) : null;
  const filter = scopeClause('scope', scope, false);
  const statusSql = status ? "AND COALESCE(solution_status, 'unverified') = ?" : '';
  try {
    return s.db.prepare(`
      SELECT * FROM notes
      WHERE deleted_at IS NULL AND superseded_by IS NULL AND problem_key = ?
        ${filter.sql} ${statusSql}
      ORDER BY
        CASE COALESCE(solution_status, 'unverified')
          WHEN 'verified' THEN 0 WHEN 'unverified' THEN 1 WHEN 'failed' THEN 2 ELSE 3
        END,
        reuse_count DESC, importance DESC, ts DESC
      LIMIT ?
    `).all(key, ...filter.params, ...(status ? [status] : []), Math.min(30, Math.max(1, Number(limit) || 8)))
      .map(row => ({
        kind: 'note',
        id: Number(row.id),
        ts: Number(row.ts),
        scope: row.scope,
        source: row.source ?? '',
        revision: Number(row.revision ?? 1),
        contested: Number(row.contested ?? 0) === 1,
        ...solutionFields(row),
        text: String(row.text).slice(0, 400),
        score: 2 + solutionBoost(row.solution_status, row.reuse_count),
        exactProblem: true,
      }));
  } catch {
    return [];
  }
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

  const filter = scopeClause('scope', scope);
  for (const row of recentWindowRows(s.db, 'facts', terms, ['text', 'subject', 'object'], filter, limit, 'AND valid_to IS NULL')) {
    push(row, 0.5);
  }
  if (s.fts.facts) {
    const bigramFilter = scopeClause('t.scope', scope);
    for (const term of terms.slice(0, 6)) {
      if (term.length === 2 && CJK_BIGRAM.test(term)) {
        for (const row of searchBigrams(s, 'fact', 'facts', term, limit, bigramFilter, 'AND t.valid_to IS NULL')) {
          if (scopeAllows(row.scope, scope)) push(row, 1);
        }
        continue;
      }
      if (term.length < 3) continue;
      const rows = rowsByIds(s.db, 'facts', ftsRowIds(s.db, 'facts_fts', term, FTS_SAMPLE), 'AND deleted_at IS NULL AND valid_to IS NULL');
      for (const row of rows) if (scopeAllows(row.scope, scope)) push(row, 0.8);
    }
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

function dreamRun(s, apply, options = {}) {
  // Flagging is safe; replacing a memory is a semantic decision. Replacement is
  // therefore opt-in and every replacement records its source as dream:<noteId>
  // so it can be rolled back.
  const commit = options.commit === true;
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
          action.proposedText = String(evidence.text).slice(0, 600);
          if (!commit) return;
          const replacementText = action.proposedText;
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

/** Evidence-backed replacement candidates for notes already flagged by a dream run. */
function dreamProposals(s, limit = 50) {
  const rows = s.db.prepare(`
    SELECT * FROM notes
    WHERE deleted_at IS NULL AND superseded_by IS NULL
      AND verification IN ('unsupported', 'contradicted')
    ORDER BY ts DESC LIMIT ?
  `).all(Math.min(Math.max(1, Number(limit) || 50), 200));
  const out = [];
  for (const note of rows) {
    const evidence = dreamEvidence(s, note, note.scope ?? SCOPE_GLOBAL);
    if (!evidence) continue;
    out.push({
      noteId: Number(note.id),
      verdict: note.verification,
      evidence: evidence.source || `chunk:${evidence.id}`,
      proposedText: String(evidence.text).slice(0, 600),
    });
  }
  return out;
}

/** Replace one flagged note with its evidence text. Explicit per-note action. */
function dreamReplace(s, noteId) {
  const result = transaction(s.db, () => {
    const note = s.db.prepare(
      'SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL AND superseded_by IS NULL'
    ).get(Number(noteId));
    if (!note) throw new Error('note not found or already superseded');
    const evidence = dreamEvidence(s, note, note.scope ?? SCOPE_GLOBAL);
    if (!evidence) throw new Error('no evidence to build a replacement');
    const replacementText = String(evidence.text).slice(0, 600);
    const info = s.db.prepare(
      'INSERT INTO notes(ts, scope, text, importance, source, revision) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(now(), note.scope, replacementText, 0.5, `dream:${note.id}`, Number(note.revision ?? 1) + 1);
    const replacementId = Number(info.lastInsertRowid);
    s.db.prepare('UPDATE notes SET superseded_by = ?, contested = 1 WHERE id = ?').run(replacementId, Number(note.id));
    if (s.fts.notes) {
      try { s.db.prepare('INSERT INTO notes_fts(rowid, text) VALUES (?, ?)').run(replacementId, replacementText); } catch { /* best effort */ }
    }
    indexBigrams(s.db, 'note', replacementId, replacementText);
    upsertVector(s, 'note', replacementId, replacementText);
    return {
      oldId: Number(note.id),
      replacementId,
      evidence: evidence.source || `chunk:${evidence.id}`,
    };
  });
  invalidateProfile();
  return result;
}

/** Undo a dream replacement: revive the original, tombstone the generated note. */
function dreamRollback(s, noteId) {
  const result = transaction(s.db, () => {
    const note = s.db.prepare('SELECT id, superseded_by FROM notes WHERE id = ?').get(Number(noteId));
    if (!note || !note.superseded_by) return { restored: false, reason: 'not superseded' };
    const replacement = s.db.prepare('SELECT id, source, deleted_at FROM notes WHERE id = ?').get(Number(note.superseded_by));
    if (!replacement || !String(replacement.source ?? '').startsWith('dream:')) {
      return { restored: false, reason: 'not a dream replacement' };
    }
    s.db.prepare('UPDATE notes SET superseded_by = NULL, contested = 0 WHERE id = ?').run(Number(note.id));
    s.db.prepare('UPDATE notes SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(now(), Number(replacement.id));
    return { restored: true, replacementId: Number(replacement.id) };
  });
  if (result.restored) invalidateProfile();
  return result;
}

/** Vector route: cosine over the stored hashed n-gram vectors. */
const VECTOR_MIN_COSINE = 0.2;
const RRF_K = 60;
// Vectors are scanned in JS. An unbounded scan over 1M rows reads gigabytes per
// query, so the route samples the most recent vectors and adds lexical candidates.
// A real ANN index is the next step, not a requirement for bounded latency.
const VECTOR_SAMPLE = Math.max(1000, Number(process.env.OMNI_VECTOR_SAMPLE ?? 5000));

async function vectorSearch(s, queryText, limit, scope, candidates = []) {
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
  const candidateIds = new Map();
  for (const hit of candidates) {
    if (!hit || !hit.kind) continue;
    const list = candidateIds.get(hit.kind) ?? [];
    if (list.length < 400) list.push(Number(hit.id));
    candidateIds.set(hit.kind, list);
  }
  const collected = new Map();
  for (const spec of specs) {
    // Sample owner ids first: a JOIN with a scope filter does not stop at LIMIT
    // when the filter rejects the first rows, so a project-scoped search used to
    // read every vector in the table.
    const sampleIds = [];
    try {
      for (const row of s.db.prepare(`
        SELECT owner_id FROM vectors WHERE kind = ? AND dim = ?
        ORDER BY owner_id DESC LIMIT ?
      `).all(spec.kind, dim, VECTOR_SAMPLE)) sampleIds.push(Number(row.owner_id));
    } catch { /* no vectors */ }
    const candidateIdsForKind = (candidateIds.get(spec.kind) ?? []).filter(id => Number.isFinite(id) && id > 0);
    const ids = [...new Set([...sampleIds, ...candidateIdsForKind])];
    const rows = [];
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500);
      const placeholders = chunk.map(() => '?').join(',');
      try {
        for (const row of s.db.prepare(`
          SELECT v.owner_id AS owner_id, v.vec AS vec, t.*
          FROM vectors v JOIN ${spec.table} t ON t.id = v.owner_id
          WHERE v.kind = ? AND v.dim = ? AND v.owner_id IN (${placeholders})
            AND t.deleted_at IS NULL ${spec.extra}
        `).all(spec.kind, dim, ...chunk)) rows.push(row);
      } catch { /* skip chunk */ }
    }
    for (const row of rows) {
      if (!scopeAllows(row.scope, scope, spec.nulls)) continue;
      const key = `${spec.kind}:${row.owner_id}`;
      if (collected.has(key)) continue;
      collected.set(key, true);
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
        scope: row.scope ?? null,
        text: String(row.text ?? '').slice(0, 400),
        source: row.source ?? '',
        ...(spec.kind === 'note' ? solutionFields(row) : {}),
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

let lastSearchProfile = null;

async function runSearch(s, query, limit, scope, options = {}) {
  const terms = queryTerms(query);
  const status = options.status && options.status !== 'all' ? solutionStatusOf(options.status) : null;
  const kind = options.kind && options.kind !== 'all' ? String(options.kind) : null;
  const hitAllowed = hit => {
    if (!hit) return false;
    if (kind && hit.kind !== kind) return false;
    if (status) {
      if (hit.kind !== 'note') return false;
      return solutionStatusOf(hit.solutionStatus ?? hit.solution_status) === status;
    }
    return true;
  };
  const profile = process.env.OMNI_PROFILE === '1'
    ? { terms: terms.length, notes: 0, facts: 0, chunks: 0, lexical: 0, vector: 0, graph: 0 }
    : null;
  const timed = async (key, fn) => {
    if (!profile) return fn();
    const started = process.hrtime.bigint();
    try {
      return await fn();
    } finally {
      profile[key] = Number(process.hrtime.bigint() - started) / 1e6;
    }
  };
  const notesHits = terms.length && (!kind || kind === 'note')
    ? await timed('notes', () => searchNotes(s, terms, limit, scope, { status }))
    : [];
  const factsHits = terms.length && (!kind || kind === 'fact') && !status
    ? await timed('facts', () => searchFacts(s, terms, limit, scope))
    : [];
  const chunksHits = terms.length && (!kind || kind === 'chunk') && !status
    ? await timed('chunks', () => searchChunks(s, terms, limit, scope))
    : [];
  const lexicalStarted = process.hrtime.bigint();
  const lexical = terms.length ? rank([...notesHits, ...factsHits, ...chunksHits].filter(hitAllowed)) : [];
  if (profile) profile.lexical = Number(process.hrtime.bigint() - lexicalStarted) / 1e6;
  // Diagnostic switch: OMNI_DISABLE_VECTOR=1 measures the lexical route alone.
  const useVector = process.env.OMNI_DISABLE_VECTOR !== '1';
  if (useVector) await flushPendingVectors(s);
  const vector = useVector ? (await timed('vector', () => vectorSearch(s, query, limit, scope, lexical))).filter(hitAllowed) : [];
  const graph = (await timed('graph', () => graphExpand(s, [...lexical, ...vector], Math.min(limit, 10), scope))).filter(hitAllowed);
  if (profile) {
    profile.hits = lexical.length + vector.length + graph.length;
    profile.at = now();
    lastSearchProfile = profile;
  }
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
    .map(entry => {
      const boost = entry.hit.kind === 'note'
        ? solutionBoost(entry.hit.solutionStatus, entry.hit.reuseCount)
        : 0;
      const exact = entry.hit.exactProblem ? 0.5 : 0;
      return {
        ...entry.hit,
        score: Number((entry.rrf + boost + exact).toFixed(6)),
        rrf: Number(entry.rrf.toFixed(6)),
        lexicalScore: entry.lexical,
        vectorScore: entry.vector,
        graphScore: entry.graph,
      };
    })
    .sort((a, b) => b.score - a.score);
  return finalizeHits(ranked, limit);
}

/**
 * Compact facts block for the profile: active rows only, grouped by
 * subject+relation so multi-valued relations show all values. Returns plain
 * lines (callers add their own bullet prefix).
 */
function profileFactLines(db, scopeKey, budget) {
  const filter = scopeKey === null || scopeKey === undefined
    ? ''
    : scopeKey === SCOPE_GLOBAL
      ? "AND (scope = 'global' OR scope IS NULL)"
      : "AND (scope = ? OR scope = 'global' OR scope IS NULL)";
  let rows;
  try {
    rows = db.prepare(`
      SELECT subject, relation, object FROM facts
      WHERE deleted_at IS NULL AND valid_to IS NULL ${filter}
      ORDER BY confidence DESC, valid_from DESC LIMIT 40
    `).all(...(scopeKey && scopeKey !== SCOPE_GLOBAL ? [scopeKey] : []));
  } catch {
    return [];
  }
  if (!rows.length) return [];
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.subject}·${row.relation}`;
    const values = groups.get(key) ?? [];
    if (values.length < 3) values.push(String(row.object ?? ''));
    groups.set(key, values);
  }
  const lines = ['相关事实：'];
  let used = lines[0].length;
  for (const [key, values] of groups) {
    const [subject, relation] = key.split('·');
    const line = `${subject} · ${relation}：${values.join(' / ')}`;
    if (used + line.length > budget) break;
    used += line.length;
    lines.push(line);
  }
  return lines.length > 1 ? lines : [];
}

const PERSONA_DEFAULT_KEYS = ['称呼', '性格', '习惯', '偏好', '其他'];
const PERSONA_MAX_VALUE = 1200;
const PERSONA_MAX_TOTAL = 4000;

function personaGet(db) {
  try {
    const rows = db.prepare('SELECT key, value FROM persona ORDER BY key').all();
    const out = {};
    for (const row of rows) out[String(row.key)] = String(row.value);
    return out;
  } catch {
    return {};
  }
}

/** Validate one persona map; arbitrary keys are allowed, values are plain text. */
function personaNormalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('values must be an object');
  const values = {};
  let total = 0;
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = String(rawKey).trim();
    const value = String(rawValue ?? '').trim();
    if (!key) continue;
    if (key.length > 40) throw new Error('persona key is too long');
    if (value.length > PERSONA_MAX_VALUE) throw new Error(`persona value for "${key}" is too long`);
    if (!value) continue;
    total += value.length;
    values[key] = value;
  }
  if (total > PERSONA_MAX_TOTAL) throw new Error('persona settings are too long');
  return values;
}

function personaSet(db, input, options = {}) {
  const values = personaNormalize(input);
  transaction(db, () => {
    if (options.replace !== false) db.exec('DELETE FROM persona');
    const insert = db.prepare(`
      INSERT INTO persona(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    for (const [key, value] of Object.entries(values)) insert.run(key, value, now());
  });
  return personaGet(db);
}

/** Evidence for persona synthesis: recent high-signal notes and active facts. */
function personaEvidence(db) {
  const notes = [];
  const facts = [];
  const technical = /(插件|面板|schema|ADR|memory_|测试|路由|接口|迁移|数据库|函数|字段|版本|用例|构建|HTTP)/i;
  try {
    const rows = db.prepare(`
      SELECT text FROM notes
      WHERE deleted_at IS NULL AND superseded_by IS NULL AND contested = 0
        AND (scope = 'global' OR scope IS NULL)
      ORDER BY importance DESC, ts DESC LIMIT 40
    `).all();
    for (const row of rows) {
      const text = String(row.text);
      if (!technical.test(text)) notes.push(text);
    }
  } catch { /* ignore */ }
  try {
    const rows = db.prepare(`
      SELECT subject, relation, object FROM facts
      WHERE deleted_at IS NULL AND valid_to IS NULL
        AND (scope = 'global' OR scope IS NULL)
      ORDER BY confidence DESC, valid_from DESC LIMIT 80
    `).all();
    for (const row of rows) facts.push(`${row.subject} ${row.relation} ${row.object}`);
  } catch { /* ignore */ }
  const utterances = [];
  try {
    const rows = db.prepare(`
      SELECT text FROM chunks
      WHERE role = 'user' AND deleted_at IS NULL
        AND (scope = 'global' OR scope IS NULL)
      ORDER BY ts DESC LIMIT 100
    `).all();
    for (const row of rows) {
      const text = String(row.text);
      if (!technical.test(text) && text.length <= 600) utterances.push(text);
    }
  } catch { /* ignore */ }
  return { notes, facts, utterances };
}

const PERSONA_RELATIONS = {
  称呼: /^(称呼|名字|昵称|name)$/i,
  偏好: /(喜欢|偏好|讨厌|常用|习惯用|prefer)/i,
  习惯: /(习惯|每天|通常|定期|固定)/i,
  性格: /(性格|风格|说话)/i,
};

/** Rule extraction: works offline; the model only refines these results. */
function personaFromRules(evidence) {
  const out = {};
  const add = (key, value) => {
    const text = String(value ?? '').trim().replace(/\s+/g, ' ');
    if (!personaValueOk(text)) return;
    out[key] = out[key] ? `${out[key]}；${text}` : text;
  };
  const userSubject = /^(用户|我|user|me)$/i;
  for (const line of evidence.facts) {
    const parts = String(line).split(' ');
    if (parts.length < 3) continue;
    const subject = parts[0];
    if (!userSubject.test(subject)) continue;
    const object = parts.slice(2).join(' ');
    const relation = parts[1];
    if (PERSONA_RELATIONS.称呼.test(relation)) add('称呼', object);
    else if (PERSONA_RELATIONS.偏好.test(relation)) add('偏好', `${relation} ${object}`);
    else if (PERSONA_RELATIONS.习惯.test(relation)) add('习惯', `${relation} ${object}`);
    else if (PERSONA_RELATIONS.性格.test(relation)) add('性格', `${relation} ${object}`);
  }
  for (const note of [...evidence.utterances, ...evidence.notes]) {
    const patterns = [
      ['称呼', /(?:叫我|称呼我|可以叫我|我的名字是)[：:\s]*(?:是)?\s*([^\n。；，,]{1,20})/],
      ['性格', /(?:我的性格|回答风格|说话方式)[：:\s是为]+([^\n。；]{1,50})/],
      ['偏好', /我(?:更|最)?(?:喜欢|偏好|讨厌|不要)[^\n。；]{0,40}/],
      ['偏好', /(?:以后|今后)[^。；\n]{2,30}(?:都|统一|用|说)[^。；\n]{0,20}/],
      ['偏好', /(?:不要|别)[^。；\n]{4,30}/],
      ['习惯', /我(?:习惯|每天|通常|定期)[^\n。；]{0,40}/],
    ];
    for (const pair of patterns) {
      const key = pair[0];
      const match = String(note).match(pair[1]);
      if (match) add(key, match[1] ?? match[0]);
    }
  }
  return out;
}

const PERSONA_BAD_VALUE = /(插件|面板|schema|ADR|memory_|测试|路由|接口|迁移|数据库|函数|字段|版本|用例|构建|HTTP|JSON|body|sessionQuery|conversation|chat|flow|API|token|\/)/i;

function personaValueOk(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length < 2 || text.length > 200) return false;
  if (PERSONA_BAD_VALUE.test(text)) return false;
  return true;
}

function parsePersonaJson(text) {
  try {
    const match = String(text ?? '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const out = {};
    for (const key of ['称呼', '性格', '习惯', '偏好', '其他']) {
      const value = String(parsed[key] ?? '').trim();
      if (personaValueOk(value)) out[key] = value;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

async function personaFromModel(ctx, evidence) {
  try {
    const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : undefined;
    if (!llm || typeof llm.stream !== 'function') return null;
    const route = await pickJudgeRoute(llm);
    if (!route) return null;
    const evidenceText = [...evidence.utterances, ...evidence.facts, ...evidence.notes]
      .map(item => `- ${String(item).replace(/\s+/g, ' ').slice(0, 160)}`)
      .join('\n')
      .slice(0, 6000);
    if (!evidenceText) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let out = '';
    try {
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        system: 'Extract the long-lived settings of the user from their memory records. Fields: 称呼 (how to address them), 性格 (communication style), 习惯 (recurring routines), 偏好 (likes/dislikes), 其他. Only use facts present in the records; empty fields are allowed. Reply with a single JSON object using those keys.',
        messages: [{ role: 'user', content: [{ type: 'text', text: `records:\n${evidenceText}\nJSON:` }] }],
        maxTokens: 400,
        temperature: 0,
        signal: controller.signal,
      });
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta') out += chunk.text ?? '';
        else if (chunk?.type === 'finish') break;
      }
    } finally {
      clearTimeout(timer);
    }
    return parsePersonaJson(out);
  } catch {
    return null;
  }
}

/** Synthesize settings from everyday memory; rules first, model refinement second. */
/** Automatic persona synthesis must be explicitly opted in before it calls the host model. */
function personaModelEnabled() {
  const value = String(process.env.OMNI_PERSONA_MODEL ?? 'off').toLowerCase();
  return value === 'auto' || value === 'on' || value === '1';
}

async function personaRefresh(ctx, options = {}) {
  const s = openStore();
  const evidence = personaEvidence(s.db);
  const rules = personaFromRules(evidence);
  const model = options.model === true ? await personaFromModel(ctx ?? hostCtx, evidence) : null;
  const existing = personaGet(s.db);
  const merged = { ...existing, ...rules, ...(model ?? {}) };
  const source = model ? 'model' : 'rules';
  const applied = options.apply === true && Object.keys(merged).length > 0;
  if (applied) {
    // Merge instead of replacing: a refresh that only found a preference must not
    // erase the user's hand-written name or custom fields.
    personaSet(s.db, merged, { replace: false });
    metaSet(s.db, 'persona_updated_at', now());
    metaSet(s.db, 'persona_source', source);
  }
  return {
    persona: options.apply === true ? personaGet(s.db) : merged,
    source,
    applied,
    modelUsed: Boolean(model),
    evidence: evidence.utterances.length + evidence.notes.length + evidence.facts.length,
  };
}

/** Occasionally re-derive persona from everyday memory (never blocks a write). */
function maybeRefreshPersona(ctx) {
  try {
    if (typeof ctx?.get !== 'function' || !ctx.get('llm')) return;
    const s = openStore();
    const pending = Number(metaGet(s.db, 'persona_pending') ?? 0) + 1;
    const last = Number(metaGet(s.db, 'persona_updated_at') ?? 0);
    if (pending < 20 || now() - last < 3_600_000) {
      metaSet(s.db, 'persona_pending', pending);
      return;
    }
    metaSet(s.db, 'persona_pending', 0);
    setTimeout(() => {
      void personaRefresh(ctx, { apply: true, model: personaModelEnabled() }).catch(() => {});
    }, 0);
  } catch { /* best effort */ }
}

/** Prompt lines for the always-injected persona block, kept short and explicit. */

function personaLines(db) {
  const values = personaGet(db);
  const keys = Object.keys(values);
  if (!keys.length) return [];
  const lines = ['用户长期设定（来自面板，高于临时指令）：'];
  for (const key of keys) {
    const line = `- ${key}：${String(values[key]).replace(/\s+/g, ' ').slice(0, 300)}`;
    lines.push(line);
  }
  return lines;
}

/** Read the highest-importance notes that fit the always-injected budget. */
function buildProfileText(projectKey) {
  const s = openStore();
  // Filter the layer in SQL instead of taking 60 rows from every project and
  // discarding most of them in JS: a busy foreign project could otherwise crowd
  // the global notes out of the profile budget.
  const noteScope = projectKey
    ? "AND (scope = 'global' OR scope IS NULL OR scope = ?)"
    : "AND (scope = 'global' OR scope IS NULL)";
  const rows = s.db.prepare(
    `SELECT id, text, importance, scope FROM notes
     WHERE deleted_at IS NULL AND superseded_by IS NULL AND contested = 0
       AND COALESCE(solution_status, 'unverified') NOT IN ('failed', 'expired') ${noteScope}
     ORDER BY importance DESC, ts DESC LIMIT 60`
  ).all(...(projectKey ? [projectKey] : []));
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

  for (const line of profileFactLines(s.db, projectKey || SCOPE_GLOBAL, PROFILE_BUDGET - used)) {
    const withBullet = line === '相关事实：' ? line : `- ${line}`;
    used += withBullet.length;
    lines.push(withBullet);
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
    // Dead ends and expired advice are useful when explicitly searched for, but
    // must not be injected as recommendations into the next turn.
    const hits = result.hits.filter(hit => hit.kind !== 'note'
      || !['failed', 'expired'].includes(String(hit.solutionStatus ?? 'unverified')));
    recallByAgent.set(agentId, { hits, query: text, at: now(), project });
  } catch { /* recall is best effort */ }
}

function projectForAgentId(agentId) {
  const id = String(agentId ?? '');
  if (!id) return null;
  const known = projectByAgent.get(id);
  if (known) return known;
  const cwd = cwdBySession.get(id);
  if (cwd) return projectKeyFromCwd(cwd);
  // Survive a plugin reload: the mapping is persisted when it is learned.
  try {
    const stored = metaGet(openStore().db, `agent_project:${id}`);
    if (stored) {
      projectByAgent.set(id, stored);
      return stored;
    }
  } catch { /* store unavailable */ }
  return null;
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
  const exact = cwdBySession.get(id);
  if (exact) {
    const project = projectKeyFromCwd(exact);
    if (project !== SCOPE_GLOBAL) return project;
  }
  // The host may hand over a truncated or opaque id (for example `session-b707`).
  // Match it only when both ids share at least 12 characters AND exactly one
  // captured session matches; an ambiguous prefix must fail closed instead of
  // guessing another project's layer.
  const matches = [];
  for (const [sessionId, cwd] of cwdBySession) {
    const common = Math.min(sessionId.length, id.length);
    if (common < 12) continue;
    if (!sessionId.startsWith(id) && !id.startsWith(sessionId)) continue;
    const project = projectKeyFromCwd(cwd);
    if (project !== SCOPE_GLOBAL && !matches.includes(project)) matches.push(project);
  }
  return matches.length === 1 ? matches[0] : null;
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
      try { metaSet(openStore().db, `agent_project:${agentId}`, project); } catch { /* best effort */ }
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
  const project = projectForScope({ id: agentId }) ?? SCOPE_GLOBAL;
  if (entry.project && entry.project !== project) return null;
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
    if (scope && scope !== SCOPE_GLOBAL && sessionId) {
      try { metaSet(openStore().db, `agent_project:${sessionId}`, scope); } catch { /* best effort */ }
    }
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
    description: 'Store one durable memory. kind=note for conclusions, rules and problem-solving experience; kind=fact for subject/relation/object triples; kind=episode for raw observations. Returns the stored id. For experience notes, set problemKey to the stable error signature and solutionStatus to what actually happened.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['note', 'fact', 'episode'], description: 'Which layer to write.' },
        text: { type: 'string', description: 'The memory, stated so it is useful without the original conversation. For a solution, include the symptom, what failed, what worked, and the preconditions.' },
        scope: {
          type: 'string',
          description: 'Optional. Omit to let the plugin judge: project-specific wording goes to the current project layer, cross-project rules to global. Pass a project key or global to override; all is read-only and rejected.',
        },
        importance: { type: 'number', description: '0..1; higher survives prompt-budget trimming longer.' },
        source: { type: 'string', description: 'Where this came from, e.g. session id plus turn, or a file path.' },
        subject: { type: 'string', description: 'fact only: the entity.' },
        relation: { type: 'string', description: 'fact only: the predicate.' },
        object: { type: 'string', description: 'fact only: the value.' },
        cardinality: {
          type: 'string',
          enum: ['single', 'multi'],
          description: 'fact only: single (default) replaces the previous value; multi keeps several active values for the same subject+relation.',
        },
        contradicts: {
          type: 'array',
          items: { type: 'number' },
          description: 'note only: ids of earlier notes this one contradicts. Both sides are flagged contested for review; nothing is merged or deleted.',
        },
        problemKey: {
          type: 'string',
          description: 'note only: stable fingerprint for the problem, such as an error code plus the failing command or a short normalized symptom. Matching is case-insensitive and whitespace-normalized.',
        },
        solutionStatus: {
          type: 'string',
          enum: ['verified', 'unverified', 'failed', 'expired'],
          description: 'note only: real-world outcome. verified means the solution worked in practice; failed means a dead end worth remembering; expired means it no longer applies in the current environment.',
        },
        evidence: {
          type: 'string',
          description: 'note only: what proves the status, e.g. a command output, a test result, a URL, or a short verification note.',
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
      const requestedStatus = args.solutionStatus == null ? null : String(args.solutionStatus).trim().toLowerCase();
      if (requestedStatus && !SOLUTION_STATUSES.has(requestedStatus)) {
        throw new Error('solutionStatus must be verified, unverified, failed, or expired');
      }
      if (kind !== 'note' && (args.problemKey || requestedStatus || args.evidence)) {
        throw new Error('problemKey, solutionStatus and evidence are note-only');
      }
      const problemKey = kind === 'note' ? normalizeProblemKey(args.problemKey) : '';
      const evidence = kind === 'note' ? String(args.evidence ?? '').trim() : '';
      const project = currentProject(toolContext);
      if (kind === 'fact') {
        const subject = canonicalEntity(s.db, args.subject ?? '');
        const relation = String(args.relation ?? 'is').trim();
        const object = String(args.object ?? args.text ?? '').trim();
        if (!subject) throw new Error('subject is required for kind=fact');
        const decision = decideScope(args.scope, text, project);
        const factScope = decision.scope;
        const requested = args.cardinality === 'single' || args.cardinality === 'multi' ? args.cardinality : null;
        const cardinality = requested ?? relationCardinality(s.db, relation);
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
          if (requested) setRelationCardinality(s.db, relation, requested);
          const insertFact = () => {
            const info = s.db.prepare(`
              INSERT INTO facts(subject, relation, object, text, valid_from, valid_to, recorded_at, confidence, source, scope, cardinality)
              VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
            `).run(
              subject, relation, object, text || `${subject} ${relation} ${object}`,
              ts, ts, 0.7, args.source ?? null, factScope, cardinality,
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
            return factId;
          };
          if (cardinality === 'multi') {
            // Several values may be true at once: keep siblings active, and treat
            // a repeated identical value as the same fact rather than a new one.
            const same = previous.find(row => String(row.object ?? '') === object);
            if (same) {
              s.db.prepare('UPDATE facts SET recorded_at = ?, source = COALESCE(?, source) WHERE id = ?')
                .run(ts, args.source ?? null, Number(same.id));
              return { factId: Number(same.id), deduped: true, invalidated: 0 };
            }
            return { factId: insertFact(), deduped: false, invalidated: 0 };
          }
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
          return { factId: insertFact(), deduped: false, invalidated: previous.length };
        });
        entityCache = { names: [], at: 0 };
        invalidateProfile();
        maybeRefreshPersona(ctx);
        enqueueJudge(ctx, {
          kind: 'fact', table: 'facts', id: Number(result.factId),
          text: text || `${subject} ${relation} ${object}`,
          project, scope: factScope, confidence: decision.confidence, reason: decision.reason,
        });
        return {
          id: Number(result.factId),
          kind: 'fact',
          deduped: result.deduped,
          invalidated: result.invalidated,
          cardinality,
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
        'SELECT id, problem_key, solution_status, evidence FROM notes WHERE scope = ? AND text = ? AND deleted_at IS NULL AND superseded_by IS NULL'
      ).get(scope, text);
      if (prev) {
        const updates = [];
        const values = [];
        if (problemKey) {
          updates.push('problem_key = ?');
          values.push(problemKey);
        }
        if (requestedStatus) {
          updates.push('solution_status = ?');
          values.push(requestedStatus);
          updates.push('solution_verified_at = ?');
          values.push(requestedStatus === 'verified' ? ts : null);
        }
        if (evidence) {
          updates.push('evidence = ?');
          values.push(evidence);
        }
        if (updates.length) {
          transaction(s.db, () => {
            s.db.prepare(`UPDATE notes SET ${updates.join(', ')} WHERE id = ?`).run(...values, Number(prev.id));
          });
          invalidateProfile();
        }
        return {
          id: Number(prev.id),
          kind: 'note',
          deduped: true,
          scope,
          scopeReason: decision.reason,
          problemKey: problemKey || prev.problem_key || null,
          solutionStatus: solutionStatusOf(requestedStatus ?? prev.solution_status),
          reuseCount: Number(s.db.prepare('SELECT reuse_count FROM notes WHERE id = ?').get(Number(prev.id))?.reuse_count ?? 0),
        };
      }
      const result = transaction(s.db, () => {
        const info = s.db.prepare(`
          INSERT INTO notes(
            ts, scope, text, importance, source, problem_key, solution_status,
            solution_verified_at, reuse_count, last_used_at, evidence
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
        `).run(
          ts, scope, text, importance, args.source ?? null,
          problemKey || null, requestedStatus,
          requestedStatus === 'verified' ? ts : null,
          evidence || null,
        );
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
        problemKey: problemKey || null,
        solutionStatus: solutionStatusOf(requestedStatus),
        reuseCount: 0,
      };
    },
  }));

  disposers.push(ctx.tools.register({
    name: 'memory_search',
    description: "Recall stored notes, facts, transcripts and problem-solving experience. When blocked by an error or tool failure, search the exact problemKey first: verified solutions rank above unverified notes, while failed attempts stay visible but lower. Then widen to keywords or the web only if the stored experience is absent or weak.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Keywords, an entity, a file path, or a phrase from the original wording. Optional when problemKey is supplied.' },
        problemKey: {
          type: 'string',
          description: 'Exact normalized error signature, e.g. "EADDRINUSE: port 8000" or "npm test fails on node 22". Exact matches are returned first.',
        },
        status: {
          type: 'string',
          enum: ['all', 'verified', 'unverified', 'failed', 'expired'],
          description: 'Optional note status filter. all (default) keeps every layer; a concrete status restricts results to notes with that real-world outcome.',
        },
        kind: {
          type: 'string',
          enum: ['all', 'note', 'fact', 'chunk'],
          description: 'Optional layer filter: note, fact, chunk, or all (default).',
        },
        limit: { type: 'number', description: 'Maximum hits, default 8, max 30.' },
        scope: {
          type: 'string',
          description: "Optional layer filter: a project scope (returns that project plus global), 'global', or 'all'. Omit to use the current project when one is known.",
        },
      },
      required: [],
    },
    output: {
      schema: { type: 'object', properties: { total: { type: 'number' }, scope: { type: 'string' }, problemKey: { type: 'string' }, hits: { type: 'array', items: { type: 'object' } } } },
      render: (_args, value) => {
        if (!value.hits.length) return textBlock(`no memory matched (scope ${value.scope ?? 'all'})`);
        const lines = value.hits.map((hit, index) => {
          const pointer = hit.source ? ` · ${hit.source}` : '';
          const flag = hit.contested ? ' · contested' : '';
          const layer = hit.scope && hit.scope !== 'global' ? ` · ${hit.scope}` : '';
          const solution = hit.solutionStatus && hit.solutionStatus !== 'unverified'
            ? ` · ${hit.solutionStatus}${hit.reuseCount ? ` ×${hit.reuseCount}` : ''}`
            : '';
          const problem = hit.problemKey ? ` · key: ${hit.problemKey}` : '';
          return `${index + 1}. [${hit.kind}#${hit.id}${layer}${flag}${solution}${problem}] ${hit.text.replace(/\s+/g, ' ')}${pointer}`;
        });
        return textBlock(`matched ${value.total} (scope ${value.scope ?? 'all'})\n${lines.join('\n')}`);
      },
    },
    async execute(args, toolContext = {}) {
      const s = openStore();
      const limit = Math.min(30, Math.max(1, Number(args.limit ?? 8)));
      const query = String(args.query ?? '');
      const problemKey = normalizeProblemKey(args.problemKey);
      const requestedStatus = String(args.status ?? 'all').trim().toLowerCase();
      if (!['all', ...SOLUTION_STATUSES].includes(requestedStatus)) {
        throw new Error('status must be all, verified, unverified, failed, or expired');
      }
      const requestedKind = String(args.kind ?? 'all').trim().toLowerCase();
      if (!['all', 'note', 'fact', 'chunk'].includes(requestedKind)) {
        throw new Error('kind must be all, note, fact, or chunk');
      }
      const requested = String(args.scope ?? '').trim();
      // Retrieval judgement: an explicit request wins; otherwise scope to the
      // current project (plus the global layer), never to every project.
      const scope = requested === 'all' ? null : (requested || currentProject(toolContext) || SCOPE_GLOBAL);
      if (!queryTerms(query).length && !problemKey) {
        return { total: 0, scope: scope ?? 'all', hits: [] };
      }
      const exact = problemKey && (requestedKind === 'all' || requestedKind === 'note')
        ? searchProblemKey(s, problemKey, limit, scope, { status: requestedStatus })
        : [];
      const result = queryTerms(query).length
        ? await runSearch(s, query, limit, scope, { status: requestedStatus, kind: requestedKind })
        : { hits: [] };
      const merged = [];
      const seen = new Set();
      for (const hit of [...exact, ...result.hits]) {
        const key = `${hit.kind}:${hit.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(hit);
        if (merged.length >= limit) break;
      }
      return {
        total: merged.length,
        scope: scope ?? 'all',
        ...(problemKey ? { problemKey } : {}),
        hits: merged,
      };
    },
  }));

  disposers.push(ctx.tools.register({
    name: 'memory_solution_report',
    description: 'Close the loop after trying a stored solution. success marks the note verified and increments its reuse count; failed records a dead end; expired marks it as no longer applicable. Call this after the result is known, not before.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'number', description: 'Note id returned by memory_write or memory_search.' },
        outcome: {
          type: 'string',
          enum: ['success', 'failed', 'expired'],
          description: 'success: the solution worked in practice; failed: it did not solve the problem; expired: it no longer applies in the current environment.',
        },
        evidence: {
          type: 'string',
          description: 'Optional: command output, test result, URL, or a short note showing why the outcome is credible.',
        },
      },
      required: ['id', 'outcome'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'number' }, solutionStatus: { type: 'string' },
          reuseCount: { type: 'number' }, lastUsedAt: { type: 'number' },
        },
      },
      render: (_args, value) => textBlock(
        `solution #${value.id} -> ${value.solutionStatus} (reused ${value.reuseCount}×)`,
      ),
    },
    async execute(args = {}) {
      const id = Number(args.id);
      const outcome = String(args.outcome ?? '').trim().toLowerCase();
      if (!Number.isFinite(id) || id <= 0) throw new Error('id is required');
      if (!['success', 'failed', 'expired'].includes(outcome)) {
        throw new Error('outcome must be success, failed, or expired');
      }
      const s = openStore();
      const note = s.db.prepare(`
        SELECT id, solution_status, reuse_count, problem_key
        FROM notes WHERE id = ? AND deleted_at IS NULL AND superseded_by IS NULL
      `).get(id);
      if (!note) throw new Error(`note ${id} not found or is no longer active`);
      const ts = now();
      const status = outcome === 'success' ? 'verified' : outcome === 'failed' ? 'failed' : 'expired';
      transaction(s.db, () => {
        s.db.prepare(`
          UPDATE notes
          SET solution_status = ?, reuse_count = reuse_count + 1,
            last_used_at = ?, solution_verified_at = ?, evidence = COALESCE(?, evidence)
          WHERE id = ?
        `).run(status, ts, outcome === 'success' ? ts : null, String(args.evidence ?? '').trim() || null, id);
      });
      invalidateProfile();
      const updated = s.db.prepare(`
        SELECT solution_status, reuse_count, last_used_at, solution_verified_at
        FROM notes WHERE id = ?
      `).get(id);
      return {
        id,
        solutionStatus: solutionStatusOf(updated?.solution_status),
        reuseCount: Number(updated?.reuse_count ?? 0),
        lastUsedAt: updated?.last_used_at ?? ts,
        verifiedAt: updated?.solution_verified_at ?? null,
      };
    },
  }));

  disposers.push(ctx.tools.register({
    name: 'memory_reindex',
    description: 'Rebuild derived indexes. Vectors: backfill for the active embedding backend (after switching OMNI_EMBED_URL/model or restoring an old database). bigrams: rebuild the whole CJK two-character index in one call (a large legacy store otherwise needs many restarts).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', description: 'Maximum vector rows to process this call, default 200, max 1000.' },
        bigrams: { type: 'boolean', description: 'true rebuilds the entire CJK bigram index (explicit, can take a while on large stores).' },
        vectors: { type: 'boolean', description: 'With bigrams: also run the vector backfill in the same call.' },
      },
    },
    output: {
      schema: { type: 'object', properties: { processed: { type: 'number' }, queued: { type: 'number' }, backend: { type: 'string' }, bigrams: { type: 'object' } } },
      render: (_args, value) => textBlock(`reindexed ${value.processed} rows (${value.backend}${value.queued ? `, ${value.queued} queued` : ''})${value.bigrams ? `; bigrams ${value.bigrams.scanned} in ${value.bigrams.passes} pass(es)` : ''}`),
    },
    async execute(args = {}) {
      const s = openStore();
      const bigrams = args.bigrams === true ? reindexBigrams(s) : null;
      const config = backendConfig();
      const limit = Math.min(1000, Math.max(1, Number(args.limit ?? 200)));
      if (args.bigrams === true && args.vectors !== true) {
        return { processed: 0, queued: 0, backend: config.kind, bigrams };
      }
      if (config.kind === 'hashed') {
        const before = Number(s.db.prepare('SELECT COUNT(*) AS n FROM vectors').get().n);
        backfillVectors(s.db, { limit });
        const after = Number(s.db.prepare('SELECT COUNT(*) AS n FROM vectors').get().n);
        return { processed: Math.max(0, after - before), queued: 0, backend: 'hashed', ...(bigrams ? { bigrams } : {}) };
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
      return { processed, queued: pendingVectors.size, backend: `remote:${dim}`, ...(bigrams ? { bigrams } : {}) };
    },
  }));

  disposers.push(ctx.tools.register({
    name: 'memory_persona',
    description: 'Read or write the long-lived user settings (name, personality, habits, preferences, custom fields). These are injected into the system prompt; values are plain text.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'refresh'], description: 'get reads, set replaces, refresh synthesizes settings from recent global memory.' },
        values: {
          type: 'object',
          additionalProperties: true,
          description: 'set only: map of field -> text. Empty values are removed; total length is capped at 4000 characters.',
        },
        apply: { type: 'boolean', description: 'refresh only: false previews; true (default) writes the merged result. Unknown fields already in persona are preserved.' },
        useModel: { type: 'boolean', description: 'refresh only: true sends evidence to the host model for refinement; false (default) uses offline rules only.' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', properties: { persona: { type: 'object' } } },
      render: (_args, value) => textBlock(
        Object.keys(value.persona).length
          ? Object.entries(value.persona).map(([key, text]) => `${key}：${text}`).join('\n')
          : 'no persona settings',
      ),
    },
    async execute(args = {}) {
      const s = openStore();
      if (String(args.action) === 'refresh') {
        return personaRefresh(hostCtx, {
          apply: args.apply !== false,
          model: args.useModel === true,
        });
      }
      if (String(args.action) === 'set') {
        if (!args.values || typeof args.values !== 'object') throw new Error('values is required for set');
        return { persona: personaSet(s.db, args.values) };
      }
      return { persona: personaGet(s.db) };
    },
  }));

  disposers.push(ctx.tools.register({
    name: 'memory_link_entity',
    description: 'Register an entity alias and merge existing facts/edges written under that alias into the canonical name. Dry run by default; apply=true rewrites the rows.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        alias: { type: 'string', description: 'The alternate spelling, e.g. "deploy" or "上线".' },
        canonical: { type: 'string', description: 'The canonical entity name to merge into.' },
        apply: { type: 'boolean', description: 'false (default) reports how many facts/edges would move; true rewrites them.' },
      },
      required: ['alias', 'canonical'],
    },
    output: {
      schema: { type: 'object', properties: { alias: { type: 'string' }, canonical: { type: 'string' }, affectedFacts: { type: 'number' }, affectedEdges: { type: 'number' }, applied: { type: 'boolean' } } },
      render: (_args, value) => textBlock(`${value.applied ? 'linked' : 'would link'} "${value.alias}" -> "${value.canonical}" (${value.affectedFacts} facts, ${value.affectedEdges} edges)`),
    },
    async execute(args = {}) {
      return linkEntity(openStore(), args.alias, args.canonical, { apply: args.apply === true });
    },
  }));

  disposers.push(ctx.tools.register({
    name: 'memory_dream_proposals',
    description: 'List replacement candidates produced by dream: flagged notes plus the evidence text that would replace them. Read-only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { limit: { type: 'number', description: 'Maximum proposals, default 50, max 200.' } },
    },
    output: {
      schema: { type: 'object', properties: { proposals: { type: 'array', items: { type: 'object' } } } },
      render: (_args, value) => {
        if (!value.proposals.length) return textBlock('no replacement proposals');
        const lines = value.proposals.map(item => `#${item.noteId} [${item.verdict}] <- ${item.evidence}: ${item.proposedText.slice(0, 120)}`);
        return textBlock(`${value.proposals.length} proposal(s)\n${lines.join('\n')}`);
      },
    },
    async execute(args = {}) {
      return { proposals: dreamProposals(openStore(), args.limit) };
    },
  }));

  disposers.push(ctx.tools.register({
    name: 'memory_dream_replace',
    description: 'Replace one flagged note with its evidence text. Requires confirm=true; the old note is superseded (kept for audit) and the replacement can be rolled back.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        noteId: { type: 'number', description: 'Note id from memory_dream_proposals.' },
        confirm: { type: 'boolean', description: 'Must be true; replacement is a semantic decision, not automatic.' },
      },
      required: ['noteId', 'confirm'],
    },
    output: {
      schema: { type: 'object', properties: { oldId: { type: 'number' }, replacementId: { type: 'number' } } },
      render: (_args, value) => textBlock(`replaced #${value.oldId} with #${value.replacementId} (rollback with memory_dream_rollback)`),
    },
    async execute(args = {}) {
      if (args.confirm !== true) throw new Error('confirm=true is required');
      return dreamReplace(openStore(), args.noteId);
    },
  }));

  disposers.push(ctx.tools.register({
    name: 'memory_dream_rollback',
    description: 'Undo a dream replacement: revive the original note and tombstone the generated replacement. Only works on replacements created by memory_dream (source dream:<id>).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { noteId: { type: 'number', description: 'The original (superseded) note id.' } },
      required: ['noteId'],
    },
    output: {
      schema: { type: 'object', properties: { restored: { type: 'boolean' }, replacementId: { type: 'number' } } },
      render: (_args, value) => textBlock(value.restored ? `restored #${_args.noteId}` : `not rolled back: ${value.reason}`),
    },
    async execute(args = {}) {
      return dreamRollback(openStore(), args.noteId);
    },
  }));

  disposers.push(ctx.tools.register({
    name: 'memory_export',
    description: 'Write a portable JSON backup (notes, facts, transcripts, edges, entities, relations, entity aliases, persona). Vectors are derived and excluded. Tombstones are included by default so a later restore can revive them.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Destination file. Defaults to a timestamped file under $DSH_HOME/memory/.' },
        activeOnly: { type: 'boolean', description: 'true exports only live rows (no tombstones, superseded notes or expired facts).' },
      },
    },
    output: {
      schema: { type: 'object', properties: { path: { type: 'string' }, counts: { type: 'object' } } },
      render: (_args, value) => textBlock(`exported ${value.counts.notes} notes, ${value.counts.facts} facts, ${value.counts.chunks} transcripts -> ${value.path}`),
    },
    async execute(args = {}) {
      const s = openStore();
      return exportBackup(s, { path: args.path, audit: !args.activeOnly });
    },
  }));

  disposers.push(ctx.tools.register({
    name: 'memory_import',
    description: 'Merge a JSON backup written by memory_export. Dry run by default: pass dryRun=false to write. Rows are deduplicated by content, not by id; vectors are rebuilt.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Backup file to read.' },
        dryRun: { type: 'boolean', description: 'true (default) reports what would be imported without writing.' },
      },
      required: ['path'],
    },
    output: {
      schema: { type: 'object', properties: { notes: { type: 'number' }, facts: { type: 'number' }, chunks: { type: 'number' }, edges: { type: 'number' }, relations: { type: 'number' }, entityAliases: { type: 'number' }, persona: { type: 'number' }, skipped: { type: 'number' }, dryRun: { type: 'boolean' } } },
      render: (_args, value) => textBlock(`${value.dryRun ? 'would import' : 'imported'} ${value.notes} notes, ${value.facts} facts, ${value.chunks} transcripts, ${value.edges} edges, ${value.relations} relations, ${value.entityAliases} aliases, ${value.persona} persona (skipped ${value.skipped})`),
    },
    async execute(args = {}) {
      const s = openStore();
      if (!args.path) throw new Error('path is required');
      return importBackup(s, { path: String(args.path), dryRun: args.dryRun !== false });
    },
  }));

  disposers.push(ctx.tools.register({
    name: 'memory_restore',
    description: 'Revive one tombstoned memory (kind + id). Derived indexes are rebuilt; use the audit view to find deleted rows.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['note', 'fact', 'chunk'], description: 'Which layer the row belongs to.' },
        id: { type: 'number', description: 'Row id from the audit view.' },
      },
      required: ['kind', 'id'],
    },
    output: {
      schema: { type: 'object', properties: { restored: { type: 'boolean' }, reason: { type: 'string' }, activeId: { type: 'number' } } },
      render: (_args, value) => textBlock(value.restored ? 'restored' : `nothing to restore${value.reason ? `: ${value.reason}` : ''}`),
    },
    async execute(args = {}) {
      const s = openStore();
      return restoreMemory(s, String(args.kind), Number(args.id));
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
        WHERE deleted_at IS NULL AND superseded_by IS NULL AND contested = 0
          AND COALESCE(solution_status, 'unverified') NOT IN ('failed', 'expired') ${filter.sql}
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
      for (const line of profileFactLines(s.db, scope, PROFILE_BUDGET - used)) {
        used += line.length;
        picked.push({ id: null, text: line === '相关事实：' ? line : line, scope: 'facts' });
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
      const rawName = String(args.entity ?? '').trim();
      if (!rawName) throw new Error('entity is required');
      // Facts are stored under their canonical subject; object values are not
      // canonicalised, so both spellings are matched.
      const name = canonicalEntity(s.db, rawName);
      const requested = String(args.scope ?? '').trim();
      const scope = requested === 'all' ? null : (requested || currentProject(toolContext) || SCOPE_GLOBAL);
      const factFilter = scope ? scopeClause('scope', scope) : { sql: '', params: [] };
      const noteFilter = scope ? scopeClause('scope', scope, false) : { sql: '', params: [] };
      const facts = s.db.prepare(`
        SELECT * FROM facts
        WHERE (subject = ? OR object LIKE ? OR object LIKE ?) AND deleted_at IS NULL ${factFilter.sql}
        ORDER BY valid_from ASC LIMIT 50
      `).all(name, `%${rawName}%`, `%${name}%`, ...factFilter.params).map(row => ({
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
    description: 'Verify stored notes against the transcripts they came from. Dry run by default; apply=true records each verdict and flags unsupported notes as contested, but never replaces anything. commit=true (with apply) or memory_dream_replace performs a reversible replacement.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        apply: { type: 'boolean', description: 'false (default) reports only; true writes verdicts and flags contested notes. It never replaces anything.' },
        commit: { type: 'boolean', description: 'Only with apply: also replace flagged notes with their evidence text. Off by default; replacement is reversible with memory_dream_rollback.' },
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
      return dreamRun(s, args.apply === true, { commit: args.commit === true });
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
      const deletedActive = audit ? '' : 'AND deleted_at IS NULL';
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
               superseded_by, verification, verified_at, evidence, deleted_at,
               problem_key, solution_status, solution_verified_at, reuse_count, last_used_at
        FROM notes WHERE 1 = 1 ${deletedActive} ${noteActive} ${scopeSql}
        ORDER BY importance DESC, ts DESC LIMIT ? OFFSET ?
      `).all(...scopeParams, limit, offset);
      const facts = s.db.prepare(`
        SELECT id, subject, relation, object, text, confidence, source,
               valid_from, valid_to, contested, scope, deleted_at
        FROM facts WHERE 1 = 1 ${deletedActive} ${factActive} ${scopeSql}
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
          SELECT id, ts, role, source, text, deleted_at FROM chunks
          WHERE deleted_at IS NULL AND scope = ?
          ORDER BY ts DESC LIMIT 20
        `).all(scopeFilter).map(row => ({
          kind: 'chunk',
          id: Number(row.id),
          ts: Number(row.ts),
          role: row.role,
          source: row.source ?? '',
          text: String(row.text).slice(0, 300),
          deleted_at: row.deleted_at ?? null,
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
          notes: count('notes', 'AND superseded_by IS NULL'),
          facts: count('facts', 'AND valid_to IS NULL'),
          chunks: count('chunks'),
          globalNotes,
          projectNotes,
          contested: count('notes', 'AND contested = 1'),
          verified: count('notes', 'AND verification IS NOT NULL'),
          solutionsVerified: count('notes', "AND solution_status = 'verified'"),
          solutionsFailed: count('notes', "AND solution_status = 'failed'"),
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
        : requested === 'project'
          ? { sql: "AND scope LIKE 'proj:%'", params: [] }
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
      const layerScope = requested === 'all' ? 'global' : requested;
      for (const name of keep) {
        addNode(`e:${name}`, 'entity', name, Math.min(1, 0.35 + (degree.get(name) ?? 0) / 12), layerScope);
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
        "SELECT COALESCE(scope, 'global') AS scope, COUNT(*) AS n FROM notes WHERE deleted_at IS NULL AND superseded_by IS NULL GROUP BY COALESCE(scope, 'global')"
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
            verifiedAt: row.solution_verified_at ?? null,
            problemKey: row.problem_key ?? null,
            solutionStatus: solutionStatusOf(row.solution_status),
            reuseCount: Number(row.reuse_count ?? 0),
            lastUsedAt: row.last_used_at ?? null,
            evidence: row.evidence ?? null,
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
    path: '/omni-memory/persona',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { ok: false });
      const s = openStore();
      const method = String(req.method ?? 'GET').toUpperCase();
      if (method === 'GET') return json(res, 200, { ok: true, persona: personaGet(s.db) });
      if (method !== 'POST') return json(res, 405, { ok: false, error: 'persona requires GET or POST' });
      if (!mutationAllowed(req)) return json(res, 403, { ok: false, error: 'forbidden' });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      let values;
      try {
        values = JSON.parse(url.searchParams.get('values') ?? '{}');
      } catch {
        return json(res, 400, { ok: false, error: 'values must be JSON' });
      }
      try {
        return json(res, 200, { ok: true, persona: personaSet(s.db, values) });
      } catch (error) {
        return json(res, 400, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/persona/refresh',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { ok: false });
      if (String(req.method ?? 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'refresh requires POST' });
      if (!mutationAllowed(req)) return json(res, 403, { ok: false, error: 'forbidden' });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const apply = String(url.searchParams.get('dryRun') ?? '') !== '1';
      const useModel = String(url.searchParams.get('model') ?? '') === '1';
      try {
        return json(res, 200, { ok: true, ...await personaRefresh(hostCtx, { apply, model: useModel }) });
      } catch (error) {
        return json(res, 400, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/dream/proposals',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { ok: false });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      return json(res, 200, { ok: true, proposals: dreamProposals(openStore(), url.searchParams.get('limit')) });
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/dream/replace',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { ok: false });
      if (String(req.method ?? 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'replace requires POST' });
      if (!mutationAllowed(req)) return json(res, 403, { ok: false, error: 'forbidden' });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const noteId = Number(url.searchParams.get('noteId') ?? 0);
      if (!noteId) return json(res, 400, { ok: false, error: 'noteId required' });
      try {
        return json(res, 200, { ok: true, ...dreamReplace(openStore(), noteId) });
      } catch (error) {
        return json(res, 400, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/dream/rollback',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { ok: false });
      if (String(req.method ?? 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'rollback requires POST' });
      if (!mutationAllowed(req)) return json(res, 403, { ok: false, error: 'forbidden' });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const noteId = Number(url.searchParams.get('noteId') ?? 0);
      if (!noteId) return json(res, 400, { ok: false, error: 'noteId required' });
      return json(res, 200, { ok: true, ...dreamRollback(openStore(), noteId) });
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/export',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { ok: false });
      const s = openStore();
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const activeOnly = String(url.searchParams.get('activeOnly') ?? '') === '1';
      const snapshot = snapshotStore(s, { audit: !activeOnly });
      if (String(url.searchParams.get('download') ?? '') === '1') {
        const name = `omni-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        res.setHeader('content-disposition', `attachment; filename="${name}"`);
      }
      return json(res, 200, { ok: true, ...snapshot });
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/restore',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { ok: false });
      const method = String(req.method ?? 'GET').toUpperCase();
      if (method !== 'POST') return json(res, 405, { ok: false, error: 'restore requires POST' });
      if (!mutationAllowed(req)) return json(res, 403, { ok: false, error: 'forbidden' });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const kind = String(url.searchParams.get('kind') ?? '');
      const id = Number(url.searchParams.get('id') ?? 0);
      if (!kind || !id) return json(res, 400, { ok: false, error: 'kind and id required' });
      const s = openStore();
      try {
        return json(res, 200, { ok: true, ...restoreMemory(s, String(kind), id) });
      } catch (error) {
        return json(res, 400, { ok: false, error: String(error?.message ?? error) });
      }
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
        lastSearch: lastSearchProfile,
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
  hostCtx = ctx;
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
        try {
          lines.push(...personaLines(openStore().db));
        } catch { /* persona is optional */ }
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

