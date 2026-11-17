/**
 * Retrieval latency benchmark (NFR-01: p95 < 300ms within 10k rows).
 *
 * Run: node bench/bench.mjs [rows] [queries]
 *
 * Derived-index pressure (both optional):
 *   BENCH_VECTORS=50000   build hashed vectors for the most recent N rows
 *   BENCH_BIGRAM=条目      insert one very common CJK bigram for every row
 *   KEEP=1                print the fixture home so SQL can be inspected
 *   OMNI_PROFILE=1        print per-stage timings from /status.lastSearch
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { DIM, embedText, toBlob } from '../lib/embed.mjs';
import { boot, fakeReq, fakeRes } from '../test/helpers.mjs';

const PROFILE = process.env.OMNI_PROFILE === '1';

const ROWS = Number(process.argv[2] ?? 10000);
const QUERIES = Number(process.argv[3] ?? 50);

const app = await boot();
await app.call('memory_profile'); // open + migrate

const db = new DatabaseSync(path.join(app.home, 'memory', 'omni.db'));
const insertNote = db.prepare('INSERT INTO notes(ts, scope, text, importance, source) VALUES (?, ?, ?, ?, ?)');
const insertFts = db.prepare('INSERT INTO notes_fts(rowid, text) VALUES (?, ?)');

const started = Date.now();
db.exec('BEGIN');
for (let i = 0; i < ROWS; i += 1) {
  const text = `压力测试条目 ${i} 关键词 alpha beta gamma 说明文字用于模拟真实长度`;
  const info = insertNote.run(Date.now() - i * 1000, 'bench', text, Math.random(), 'bench');
  try { insertFts.run(Number(info.lastInsertRowid), text); } catch { /* ignore */ }
}
db.exec('COMMIT');

// Derived-index pressure: vectors for the most recent N rows and one very
// common CJK bigram across every row. Both exercise the bounded scans.
const derivedStart = Date.now();
const vectorRows = Number(process.env.BENCH_VECTORS ?? 0);
if (vectorRows > 0) {
  const insertVector = db.prepare('INSERT OR REPLACE INTO vectors(kind, owner_id, dim, vec) VALUES (?, ?, ?, ?)');
  const rows = db.prepare('SELECT id, text FROM notes ORDER BY id DESC LIMIT ?').all(vectorRows);
  db.exec('BEGIN');
  for (const row of rows) insertVector.run('note', Number(row.id), DIM, toBlob(embedText(String(row.text))));
  db.exec('COMMIT');
}
if (process.env.BENCH_BIGRAM) {
  const insertBigram = db.prepare('INSERT OR IGNORE INTO bigrams(layer, owner_id, gram) VALUES (?, ?, ?)');
  db.exec('BEGIN');
  for (const row of db.prepare('SELECT id FROM notes').all()) insertBigram.run('note', Number(row.id), String(process.env.BENCH_BIGRAM));
  db.exec('COMMIT');
}
const derivedMs = Date.now() - derivedStart;
const seedMs = Date.now() - started;
db.close();

const samples = [];
const profiles = [];
for (let i = 0; i < QUERIES; i += 1) {
  const query = i % 3 === 0 ? 'alpha beta' : i % 3 === 1 ? '压力测试条目' : `条目 ${i}`;
  const t0 = process.hrtime.bigint();
  await app.call('memory_search', { query, limit: 8 });
  const t1 = process.hrtime.bigint();
  samples.push(Number(t1 - t0) / 1e6);
  if (PROFILE) {
    const probe = fakeRes();
    await app.route('/omni-memory/status').handler(fakeReq('/omni-memory/status'), probe.res);
    const profile = probe.json().lastSearch;
    if (profile) profiles.push(profile);
  }
}

samples.sort((a, b) => a - b);
const at = p => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];
const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;

const average = key => profiles.length
  ? Number((profiles.reduce((sum, item) => sum + Number(item[key] ?? 0), 0) / profiles.length).toFixed(1))
  : null;
if (process.env.KEEP === '1') console.error('HOME=' + app.home);
console.log(JSON.stringify({
  rows: ROWS,
  queries: QUERIES,
  seedMs,
  derivedMs,
  p50: Number(at(0.5).toFixed(1)),
  p95: Number(at(0.95).toFixed(1)),
  max: Number(samples[samples.length - 1].toFixed(1)),
  mean: Number(mean.toFixed(1)),
  budgetP95: 300,
  pass: at(0.95) < 300,
  ...(PROFILE ? {
    profileMeanMs: {
      notes: average('notes'), facts: average('facts'), chunks: average('chunks'),
      lexical: average('lexical'), vector: average('vector'), graph: average('graph'),
    },
  } : {}),
}, null, 2));
