import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { boot } from './helpers.mjs';

function dbOf(home) {
  const db = new DatabaseSync(path.join(home, 'memory', 'omni.db'));
  db.exec('PRAGMA busy_timeout = 3000');
  return db;
}

test('memory_reindex bigrams rebuilds the whole CJK index in one call', async () => {
  const app = await boot();
  await app.call('memory_write', { kind: 'note', scope: 'global', text: '索引重建 项目部署 稳定性验证' });
  await app.call('memory_write', {
    kind: 'fact', scope: 'global', text: '部署 方式 裸机', subject: '部署', relation: '方式', object: '裸机',
  });
  app.fire('user/message', '一条包含中文两字词 部署 的转录', 1, 'session-reindex');

  const db = dbOf(app.home);
  const before = Number(db.prepare('SELECT COUNT(*) AS n FROM bigrams').get().n);
  assert.ok(before > 0, 'writes keep the bigram index in sync');
  // Simulate a legacy store: derived index missing, cursor state reset.
  db.exec('DELETE FROM bigrams');
  db.prepare("UPDATE meta SET value = '0' WHERE key = 'bigrams_version'").run();
  db.close();

  const rebuilt = await app.call('memory_reindex', { bigrams: true });
  assert.equal(rebuilt.value.bigrams.done, true);
  assert.ok(rebuilt.value.bigrams.scanned >= 3, 'all three layers are scanned');

  const after = dbOf(app.home);
  const restored = Number(after.prepare('SELECT COUNT(*) AS n FROM bigrams').get().n);
  const version = after.prepare("SELECT value FROM meta WHERE key = 'bigrams_version'").get()?.value;
  after.close();
  assert.ok(restored > 0, 'bigram rows are rebuilt');
  assert.equal(version, String(app.mod.SCHEMA_VERSION));

  const hits = await app.call('memory_search', { query: '部署', scope: 'all' });
  assert.ok(hits.value.hits.length > 0, 'two-character CJK search works after rebuild');
});
