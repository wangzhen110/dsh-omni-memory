import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { boot, fakeReq, fakeRes } from './helpers.mjs';

function chunkRows(home) {
  const db = new DatabaseSync(path.join(home, 'memory', 'omni.db'));
  const rows = db.prepare('SELECT id, deleted_at FROM chunks ORDER BY id').all();
  db.close();
  return rows;
}

test('memory_compact is a dry run by default', async () => {
  const app = await boot();
  for (let i = 0; i < 60; i += 1) app.fire('user/message', `压缩测试消息 ${i}`, i + 1);
  const dry = await app.call('memory_compact', { keepChunks: 50 });
  assert.equal(dry.value.total, 60);
  assert.equal(dry.value.excess, 10);
  assert.equal(dry.value.tombstoned, 0);
  assert.equal(chunkRows(app.home).filter(row => row.deleted_at === null).length, 60);
});

test('memory_compact tombstones only the excess rows', async () => {
  const app = await boot();
  for (let i = 0; i < 60; i += 1) app.fire('user/message', `压缩测试消息 ${i}`, i + 1);
  const applied = await app.call('memory_compact', { keepChunks: 50, apply: true });
  assert.equal(applied.value.tombstoned, 10);
  const rows = chunkRows(app.home);
  assert.equal(rows.length, 60, 'rows must never be physically deleted');
  assert.equal(rows.filter(row => row.deleted_at === null).length, 50);
});

test('memory_compact respects the minimum keep limit', async () => {
  const app = await boot();
  for (let i = 0; i < 60; i += 1) app.fire('user/message', `下限测试消息 ${i}`, i + 1);
  const applied = await app.call('memory_compact', { keepChunks: 1, apply: true });
  assert.equal(applied.value.tombstoned, 10, 'keep limit is clamped to 50');
});

test('tombstoned chunks disappear from recall but stay auditable', async () => {
  const app = await boot();
  for (let i = 0; i < 55; i += 1) app.fire('user/message', `可审计消息 ${i}`, i + 1);
  await app.call('memory_compact', { keepChunks: 50, apply: true });
  const hit = await app.call('memory_search', { query: '可审计消息 0', limit: 20 });
  assert.equal(hit.value.hits.every(item => item.kind !== 'chunk' || !String(item.text).endsWith(' 0')), true);
});

test('D-10 the list route reports pagination metadata', async () => {
  const app = await boot();
  for (let i = 0; i < 5; i += 1) {
    await app.call('memory_write', { kind: 'note', text: `分页笔记 ${i}`, importance: 0.5 });
  }
  const first = fakeRes();
  await app.route('/omni-memory/list').handler(fakeReq('/omni-memory/list?limit=2&offset=0'), first.res);
  const firstBody = first.json();
  assert.equal(firstBody.page.limit, 2);
  assert.equal(firstBody.page.offset, 0);
  assert.equal(firstBody.page.totalNotes, 5);
  assert.equal(firstBody.page.hasMoreNotes, true);
  assert.equal(firstBody.notes.length, 2);

  const last = fakeRes();
  await app.route('/omni-memory/list').handler(fakeReq('/omni-memory/list?limit=2&offset=4'), last.res);
  const lastBody = last.json();
  assert.equal(lastBody.notes.length, 1);
  assert.equal(lastBody.page.hasMoreNotes, false);
});

test('D-10 the list route exposes verification and contested state', async () => {
  const app = await boot();
  app.fire('assistant/message', '部署方式最终选择裸机进程方案', 1, 'listcase');
  const written = await app.call('memory_write', {
    kind: 'note', text: '部署方式最终选择 Docker 容器方案', source: 'session:listcase#1',
  });
  await app.call('memory_dream', { apply: true, commit: true });

  // The working list shows live memory only: a dream-replaced note is history.
  const live = fakeRes();
  await app.route('/omni-memory/list').handler(fakeReq('/omni-memory/list?limit=10'), live.res);
  const liveBody = live.json();
  assert.equal(liveBody.notes.some(note => note.id === written.value.id), false);

  // `audit=1` keeps the replacement visible with its verification evidence.
  const audit = fakeRes();
  await app.route('/omni-memory/list').handler(fakeReq('/omni-memory/list?limit=10&audit=1'), audit.res);
  const body = audit.json();
  const row = body.notes.find(note => note.id === written.value.id);
  assert.ok(row, 'the note must be listed in audit mode');
  assert.equal(row.contested, 1);
  assert.equal(row.verification, 'contradicted');
  assert.equal(row.evidence, 'session:listcase#1');
  assert.equal(typeof row.superseded_by, 'number');
  assert.ok(body.stats.contested >= 1);
  assert.ok(body.stats.verified >= 1);
});
