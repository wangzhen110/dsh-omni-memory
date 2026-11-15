import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { boot } from './helpers.mjs';

function noteFlags(home, ids) {
  const db = new DatabaseSync(path.join(home, 'memory', 'omni.db'));
  const rows = db.prepare(`SELECT id, contested FROM notes WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids);
  db.close();
  return Object.fromEntries(rows.map(row => [Number(row.id), Number(row.contested)]));
}

test('FR-19 an explicit contradiction marks both notes as contested', async () => {
  const app = await boot();
  const first = await app.call('memory_write', { kind: 'note', text: '部署方式用 Docker 容器' });
  const second = await app.call('memory_write', {
    kind: 'note', text: '部署方式改用裸机进程', contradicts: [first.value.id],
  });
  assert.deepEqual(second.value.contestedWith, [first.value.id]);
  const flags = noteFlags(app.home, [first.value.id, second.value.id]);
  assert.equal(flags[first.value.id], 1);
  assert.equal(flags[second.value.id], 1);
});

test('FR-19 a near-duplicate note is flagged automatically', async () => {
  const app = await boot();
  const first = await app.call('memory_write', { kind: 'note', text: '用户偏好：直接执行，不做多余确认' });
  const second = await app.call('memory_write', { kind: 'note', text: '用户偏好：直接执行，不做多余确认。' });
  assert.ok(second.value.contestedWith.includes(first.value.id));
  const flags = noteFlags(app.home, [first.value.id, second.value.id]);
  assert.equal(flags[first.value.id], 1);
  assert.equal(flags[second.value.id], 1);
});

test('FR-19 unrelated notes are not flagged', async () => {
  const app = await boot();
  const first = await app.call('memory_write', { kind: 'note', text: '数据库使用 WAL 模式' });
  const second = await app.call('memory_write', { kind: 'note', text: '界面左侧放导航入口' });
  assert.deepEqual(second.value.contestedWith, []);
  const flags = noteFlags(app.home, [first.value.id, second.value.id]);
  assert.equal(flags[first.value.id], 0);
  assert.equal(flags[second.value.id], 0);
});

test('FR-19 contested notes surface the flag in search results', async () => {
  const app = await boot();
  const first = await app.call('memory_write', { kind: 'note', text: '缓存策略采用内存缓存' });
  await app.call('memory_write', { kind: 'note', text: '缓存策略采用磁盘缓存', contradicts: [first.value.id] });
  const hit = await app.call('memory_search', { query: '缓存策略' });
  assert.ok(hit.value.hits.length >= 1);
  assert.ok(hit.value.hits.every(item => item.contested === true));
});

test('FR-19 an unknown contradicts id is ignored instead of throwing', async () => {
  const app = await boot();
  const written = await app.call('memory_write', {
    kind: 'note', text: '引用不存在的争议目标', contradicts: [9999, -1, 'abc'],
  });
  assert.deepEqual(written.value.contestedWith, []);
});
