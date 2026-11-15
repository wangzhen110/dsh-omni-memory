import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

test('FR-06 CJK substring is found without spaces (bigram tokenisation)', async () => {
  const app = await boot();
  await app.call('memory_write', { kind: 'note', text: '上次那个插件报错是因为 inspectSession' });
  const hit = await app.call('memory_search', { query: '插件报错' });
  assert.equal(hit.value.hits.length, 1);
  assert.match(hit.value.hits[0].text, /插件报错/);
});

test('FR-07 an English identifier is matched exactly', async () => {
  const app = await boot();
  await app.call('memory_write', { kind: 'note', text: '崩溃点 sessionQuery.inspectSession' });
  const hit = await app.call('memory_search', { query: 'inspectSession' });
  assert.equal(hit.value.hits.length, 1);
});

test('FR-08 one query spans notes, facts and transcripts', async () => {
  const app = await boot();
  await app.call('memory_write', { kind: 'note', text: '共同关键词甲：笔记层' });
  await app.call('memory_write', { kind: 'fact', subject: '共同关键词甲', relation: '层级', object: '事实层', text: '共同关键词甲 属于 事实层' });
  await app.call('memory_write', { kind: 'episode', text: '共同关键词甲：转录层' });
  const hit = await app.call('memory_search', { query: '共同关键词甲', limit: 10 });
  const kinds = new Set(hit.value.hits.map(item => item.kind));
  assert.ok(kinds.has('note'));
  assert.ok(kinds.has('fact'));
  assert.ok(kinds.has('chunk'));
});

test('identical text across layers is reported once', async () => {
  const app = await boot();
  const text = '同一句话在两层都出现';
  await app.call('memory_write', { kind: 'note', text });
  await app.call('memory_write', { kind: 'episode', text });
  const hit = await app.call('memory_search', { query: '同一句话' });
  assert.equal(hit.value.hits.length, 1);
});

test('an empty query returns no hits without throwing', async () => {
  const app = await boot();
  const hit = await app.call('memory_search', { query: '   ' });
  assert.deepEqual(hit.value.hits, []);
});

test('hits are ordered by score descending', async () => {
  const app = await boot();
  await app.call('memory_write', { kind: 'note', text: '排序测试 高权重', importance: 0.95 });
  await app.call('memory_write', { kind: 'note', text: '排序测试 低权重', importance: 0.1 });
  const hit = await app.call('memory_search', { query: '排序测试' });
  assert.equal(hit.value.hits.length, 2);
  assert.ok(hit.value.hits[0].score >= hit.value.hits[1].score);
});

test('scope narrows notes when an exact scope exists', async () => {
  const app = await boot();
  await app.call('memory_write', { kind: 'note', text: '作用域过滤 甲的笔记', scope: 'proj:a' });
  await app.call('memory_write', { kind: 'note', text: '作用域过滤 乙的笔记', scope: 'proj:b' });
  const hit = await app.call('memory_search', { query: '作用域过滤', scope: 'proj:b' });
  assert.equal(hit.value.hits.length, 1);
  assert.match(hit.value.hits[0].text, /乙的笔记/);
});

test('limit is clamped and respected', async () => {
  const app = await boot();
  for (let i = 0; i < 5; i += 1) {
    await app.call('memory_write', { kind: 'note', text: `限量测试第 ${i} 条` });
  }
  const hit = await app.call('memory_search', { query: '限量测试', limit: 2 });
  assert.equal(hit.value.hits.length, 2);
});
