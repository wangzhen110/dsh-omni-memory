/**
 * Retrieval latency benchmark (NFR-01: p95 < 300ms within 10k rows).
 *
 * Run: node bench/bench.mjs [rows] [queries]
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { boot } from '../test/helpers.mjs';

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
const seedMs = Date.now() - started;
db.close();

const samples = [];
for (let i = 0; i < QUERIES; i += 1) {
  const query = i % 3 === 0 ? 'alpha beta' : i % 3 === 1 ? '压力测试条目' : `条目 ${i}`;
  const t0 = process.hrtime.bigint();
  await app.call('memory_search', { query, limit: 8 });
  const t1 = process.hrtime.bigint();
  samples.push(Number(t1 - t0) / 1e6);
}

samples.sort((a, b) => a - b);
const at = p => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];
const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;

console.log(JSON.stringify({
  rows: ROWS,
  queries: QUERIES,
  seedMs,
  p50: Number(at(0.5).toFixed(1)),
  p95: Number(at(0.95).toFixed(1)),
  max: Number(samples[samples.length - 1].toFixed(1)),
  mean: Number(mean.toFixed(1)),
  budgetP95: 300,
  pass: at(0.95) < 300,
}, null, 2));
