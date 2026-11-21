import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, fakeReq, fakePost, fakeRes } from './helpers.mjs';

test('GET /omni-memory/packet returns a prompt-ready profile and task hits', async () => {
  const app = await boot();
  const profile = await app.call('memory_write', {
    kind: 'note', text: 'PacketProfile 全局偏好：回答先给结论', importance: 0.9,
  });
  const task = await app.call('memory_write', {
    kind: 'note', text: 'PacketTask 部署端口是 7788', importance: 0.6,
  });

  const { res, state, json } = fakeRes();
  await app.route('/omni-memory/packet').handler(
    fakeReq('/omni-memory/packet?q=PacketTask&limit=3&budget=1800'),
    res,
  );
  assert.equal(state.statusCode, 200);
  const body = json();
  assert.equal(body.ok, true);
  assert.equal(body.scope, 'global');
  assert.match(body.text, /PacketProfile/);
  assert.match(body.text, /PacketTask/);
  assert.ok(body.chars <= 1800);
  assert.ok(body.memories.some(item => item.id === task.value.id));
  assert.ok(body.memories.every(item => item.id !== profile.value.id || item.kind === 'note'));
});

test('packet text mode and project scope do not leak another project', async () => {
  const app = await boot();
  const global = await app.call('memory_write', { kind: 'note', text: 'PacketScope global rule' });
  await app.call('memory_write', { kind: 'note', text: 'PacketScope alpha note', scope: 'proj:alpha' });
  await app.call('memory_write', { kind: 'note', text: 'PacketScope beta note', scope: 'proj:beta' });

  const { res, state } = fakeRes();
  await app.route('/omni-memory/packet').handler(
    fakeReq('/omni-memory/packet?q=PacketScope&scope=proj:alpha&format=text'),
    res,
  );
  assert.equal(state.statusCode, 200);
  assert.match(state.body, /PacketScope global rule/);
  assert.match(state.body, /PacketScope alpha note/);
  assert.doesNotMatch(state.body, /PacketScope beta note/);
  assert.match(String(state.headers['content-type']), /text\/plain/);
  assert.ok(global.value.id > 0);
});

test('GET /omni-memory/openapi.json publishes the adapter surface', async () => {
  const app = await boot();
  const { res, state, json } = fakeRes();
  await app.route('/omni-memory/openapi.json').handler(fakeReq('/omni-memory/openapi.json'), res);
  assert.equal(state.statusCode, 200);
  const spec = json();
  assert.equal(spec.openapi, '3.0.3');
  assert.ok(spec.paths['/omni-memory/packet']);
  assert.ok(spec.paths['/omni-memory/search']);
  assert.ok(spec.paths['/omni-memory/tool']);
  assert.ok(spec.paths['/omni-memory/tool'].post);
});

test('POST /omni-memory/tool bridges writes and reads, but rejects maintenance tools', async () => {
  const app = await boot();
  const write = fakePost(
    { name: 'memory_write', arguments: { kind: 'note', text: 'ToolBridge note' } },
    '127.0.0.1',
    '/omni-memory/tool',
  );
  write.headers = { host: '127.0.0.1', 'x-omni-csrf': '1' };
  const writeRes = fakeRes();
  await app.route('/omni-memory/tool').handler(write, writeRes.res);
  assert.equal(writeRes.state.statusCode, 200);
  assert.ok(writeRes.json().value.id > 0);

  const search = fakePost(
    { name: 'memory_search', arguments: { query: 'ToolBridge', scope: 'all' } },
    '127.0.0.1',
    '/omni-memory/tool',
  );
  search.headers = { host: '127.0.0.1', 'x-omni-csrf': '1' };
  const searchRes = fakeRes();
  await app.route('/omni-memory/tool').handler(search, searchRes.res);
  assert.equal(searchRes.state.statusCode, 200);
  assert.equal(searchRes.json().value.hits.length, 1);

  const exportAttempt = fakePost(
    { name: 'memory_export', arguments: { path: 'C:/should-not-write.json' } },
    '127.0.0.1',
    '/omni-memory/tool',
  );
  exportAttempt.headers = { host: '127.0.0.1', 'x-omni-csrf': '1' };
  const exportRes = fakeRes();
  await app.route('/omni-memory/tool').handler(exportAttempt, exportRes.res);
  assert.equal(exportRes.state.statusCode, 400);

  const noCsrf = fakePost({ name: 'memory_search', arguments: { query: 'ToolBridge' } }, '127.0.0.1', '/omni-memory/tool');
  noCsrf.headers = { host: '127.0.0.1' };
  const noCsrfRes = fakeRes();
  await app.route('/omni-memory/tool').handler(noCsrf, noCsrfRes.res);
  assert.equal(noCsrfRes.state.statusCode, 403);
});
