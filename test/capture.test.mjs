import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

test('FR-04 user and assistant messages are captured into chunks', async () => {
  const app = await boot();
  app.fire('user/message', '请直接执行，不要反复确认', 1);
  app.fire('assistant/message', '好的，后续默认直接执行', 2);
  const profile = await app.call('memory_profile');
  assert.equal(profile.value.stats.chunks, 2);
});

test('FR-04 captured text is searchable and keeps its source pointer', async () => {
  const app = await boot();
  app.fire('user/message', '这段话应该能被检索到', 7, 'session-abc');
  const hit = await app.call('memory_search', { query: '能被检索到' });
  assert.equal(hit.value.hits.length, 1);
  assert.match(hit.value.hits[0].source, /session:session-abc#7/);
});

test('FR-04 identical captured text is stored once', async () => {
  const app = await boot();
  app.fire('user/message', '重复的消息', 1);
  app.fire('user/message', '重复的消息', 2);
  const profile = await app.call('memory_profile');
  assert.equal(profile.value.stats.chunks, 1);
});

test('FR-05 capture never throws on a malformed event', async () => {
  const app = await boot();
  assert.doesNotThrow(() => app.fireRaw({ type: 'user/message' }));
  assert.doesNotThrow(() => app.fireRaw({}));
  assert.doesNotThrow(() => app.fireRaw({ type: 'user/message', data: { message: {} } }));
});

test('FR-05 non-message events are ignored', async () => {
  const app = await boot();
  app.fireRaw({ type: 'tool/call', seq: 1, time: Date.now(), data: { tool: { name: 'bash' } } });
  const profile = await app.call('memory_profile');
  assert.equal(profile.value.stats.chunks, 0);
});

test('FR-05 over-long messages are truncated instead of rejected', async () => {
  const app = await boot();
  app.fire('user/message', 'x'.repeat(9000), 1);
  const profile = await app.call('memory_profile');
  assert.equal(profile.value.stats.chunks, 1);
});
