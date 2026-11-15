import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

test('D-06 a scoped fact is excluded from another scope query', async () => {
  const app = await boot();
  await app.call('memory_write', {
    kind: 'fact', subject: '作用域实体', relation: '归属', object: '甲项目',
    text: '作用域实体 归属 甲项目', scope: 'proj:a',
  });
  const other = await app.call('memory_search', { query: '作用域实体', scope: 'proj:b' });
  assert.equal(other.value.hits.length, 0);
  const own = await app.call('memory_search', { query: '作用域实体', scope: 'proj:a' });
  assert.equal(own.value.hits.length, 1);
});

test('D-06 an unscoped fact stays visible under any scope', async () => {
  const app = await boot();
  await app.call('memory_write', {
    kind: 'fact', subject: '全局实体', relation: '归属', object: '全局', text: '全局实体 归属 全局',
  });
  const scoped = await app.call('memory_search', { query: '全局实体', scope: 'proj:a' });
  assert.equal(scoped.value.hits.length, 1);
});

test('D-06 a scoped episode is excluded from another scope query', async () => {
  const app = await boot();
  await app.call('memory_write', { kind: 'episode', text: '带作用域的观察记录', scope: 'proj:a' });
  const other = await app.call('memory_search', { query: '带作用域', scope: 'proj:b' });
  assert.equal(other.value.hits.length, 0);
  const own = await app.call('memory_search', { query: '带作用域', scope: 'proj:a' });
  assert.equal(own.value.hits.length, 1);
});

test('D-06 captured transcripts carry no scope and stay visible', async () => {
  const app = await boot();
  app.fire('user/message', '无作用域的捕获内容', 1);
  const scoped = await app.call('memory_search', { query: '无作用域', scope: 'proj:any' });
  assert.equal(scoped.value.hits.length, 1);
});

test('notes remain isolated per scope after the change', async () => {
  const app = await boot();
  await app.call('memory_write', { kind: 'note', text: '作用域笔记甲', scope: 'proj:a' });
  await app.call('memory_write', { kind: 'note', text: '作用域笔记乙', scope: 'proj:b' });
  const hit = await app.call('memory_search', { query: '作用域笔记', scope: 'proj:b' });
  assert.equal(hit.value.hits.length, 1);
  assert.match(hit.value.hits[0].text, /乙/);
});
