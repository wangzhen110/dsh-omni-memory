import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { boot } from './helpers.mjs';

function openDb(home) {
  return new DatabaseSync(path.join(home, 'memory', 'omni.db'));
}

test('writing a note stores exactly one vector row', async () => {
  const app = await boot();
  const written = await app.call('memory_write', { kind: 'note', text: '向量索引写入验证' });
  const db = openDb(app.home);
  const row = db.prepare('SELECT COUNT(*) AS n FROM vectors WHERE kind = ? AND owner_id = ?')
    .get('note', written.value.id);
  assert.equal(Number(row.n), 1);
  db.close();
});

test('facts and episodes are vectorised too', async () => {
  const app = await boot();
  await app.call('memory_write', {
    kind: 'fact', subject: '向量实体', relation: '状态', object: '已索引', text: '向量实体 状态 已索引',
  });
  await app.call('memory_write', { kind: 'episode', text: '向量片段记录' });
  const db = openDb(app.home);
  const kinds = db.prepare('SELECT kind, COUNT(*) AS n FROM vectors GROUP BY kind').all();
  const map = Object.fromEntries(kinds.map(row => [row.kind, Number(row.n)]));
  assert.equal(map.fact, 1);
  assert.equal(map.chunk, 1);
  db.close();
});

test('legacy rows receive vectors during migration backfill', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-vecfill-'));
  mkdirSync(path.join(home, 'memory'), { recursive: true });
  const legacy = openDb(home);
  legacy.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, scope TEXT NOT NULL DEFAULT 'global',
      text TEXT NOT NULL, importance REAL NOT NULL DEFAULT 0.5, source TEXT,
      revision INTEGER NOT NULL DEFAULT 1, superseded_by INTEGER, contested INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER);
  `);
  legacy.prepare('INSERT INTO notes(ts, text, importance) VALUES (?, ?, ?)').run(1, '迁移前的老笔记需要补向量', 0.9);
  legacy.close();

  const app = await boot({ home });
  await app.call('memory_profile');
  const db = openDb(home);
  const row = db.prepare("SELECT COUNT(*) AS n FROM vectors WHERE kind = 'note'").get();
  assert.equal(Number(row.n), 1);
  db.close();
});

test('a forgotten row is excluded from the vector route', async () => {
  const app = await boot();
  const written = await app.call('memory_write', { kind: 'note', text: '会被遗忘的向量条目' });
  await app.call('memory_forget', { kind: 'note', id: written.value.id });
  const hit = await app.call('memory_search', { query: '会被遗忘的向量条目' });
  assert.equal(hit.value.hits.length, 0);
});

test('hybrid hits carry both lexical and vector signals when both routes match', async () => {
  const app = await boot();
  await app.call('memory_write', { kind: 'note', text: '混合检索需要同时被两条路径命中', importance: 0.9 });
  const hit = await app.call('memory_search', { query: '混合检索 两条路径' });
  assert.equal(hit.value.hits.length, 1);
  const first = hit.value.hits[0];
  assert.ok(first.lexicalScore > 0, 'lexical route should contribute');
  assert.ok(first.vectorScore > 0, 'vector route should contribute');
  assert.ok(first.rrf > 0);
});

test('an unrelated query produces no vector-only hits', async () => {
  const app = await boot();
  await app.call('memory_write', { kind: 'note', text: '关于数据库迁移与索引的工程笔记' });
  const hit = await app.call('memory_search', { query: 'quantum chromodynamics lattice' });
  assert.equal(hit.value.hits.length, 0);
});

test('the vector route respects scope', async () => {
  const app = await boot();
  await app.call('memory_write', { kind: 'note', text: '作用域内的向量条目', scope: 'proj:a' });
  const other = await app.call('memory_search', { query: '作用域内的向量条目', scope: 'proj:b' });
  assert.equal(other.value.hits.length, 0);
  const own = await app.call('memory_search', { query: '作用域内的向量条目', scope: 'proj:a' });
  assert.equal(own.value.hits.length, 1);
});
