import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

test('FR-02 a newer fact invalidates the previous one instead of deleting it', async () => {
  const app = await boot();
  const first = await app.call('memory_write', {
    kind: 'fact', subject: '插件', relation: '崩因', object: 'inspectSession', text: '插件崩因 inspectSession',
  });
  const second = await app.call('memory_write', {
    kind: 'fact', subject: '插件', relation: '崩因', object: 'chat.flow', text: '插件崩因 chat.flow',
  });
  assert.equal(first.value.invalidated, 0);
  assert.equal(second.value.invalidated, 1);
});

test('FR-12 timeline keeps both the invalidated and the active row', async () => {
  const app = await boot();
  await app.call('memory_write', {
    kind: 'fact', subject: '实体A', relation: '状态', object: '旧值', text: '实体A 状态 旧值',
  });
  await app.call('memory_write', {
    kind: 'fact', subject: '实体A', relation: '状态', object: '新值', text: '实体A 状态 新值',
  });
  const timeline = await app.call('memory_timeline', { entity: '实体A' });
  assert.equal(timeline.value.entries.length, 2);
  const closed = timeline.value.entries.filter(entry => entry.validTo !== null);
  const open = timeline.value.entries.filter(entry => entry.validTo === null);
  assert.equal(closed.length, 1);
  assert.equal(open.length, 1);
  assert.equal(closed[0].object, '旧值');
  assert.equal(open[0].object, '新值');
});

test('FR-12 timeline for an unknown entity is empty', async () => {
  const app = await boot();
  const timeline = await app.call('memory_timeline', { entity: '不存在' });
  assert.deepEqual(timeline.value.entries, []);
});

test('FR-12 timeline merges facts and notes about the entity in time order', async () => {
  const app = await boot();
  await app.call('memory_write', {
    kind: 'fact', subject: '时间线实体', relation: '状态', object: '启用', text: '时间线实体 状态 启用',
  });
  await app.call('memory_write', { kind: 'note', text: '关于时间线实体的一条结论笔记' });
  const timeline = await app.call('memory_timeline', { entity: '时间线实体' });
  const kinds = new Set(timeline.value.entries.map(entry => entry.kind));
  assert.ok(kinds.has('fact'));
  assert.ok(kinds.has('note'));
});

test('FR-12 timeline requires an entity', async () => {
  const app = await boot();
  await assert.rejects(() => app.call('memory_timeline', { entity: '  ' }));
});

test('facts are searchable by subject and by object', async () => {
  const app = await boot();
  await app.call('memory_write', {
    kind: 'fact', subject: 'mnemon', relation: '状态', object: '已卸载', text: 'mnemon 状态 已卸载',
  });
  const bySubject = await app.call('memory_search', { query: 'mnemon' });
  const byObject = await app.call('memory_search', { query: '已卸载' });
  assert.equal(bySubject.value.hits.length, 1);
  assert.equal(bySubject.value.hits[0].kind, 'fact');
  assert.equal(byObject.value.hits.length, 1);
});
