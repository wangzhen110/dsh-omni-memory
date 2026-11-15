import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

test('FR-01 writes a note and returns its id', async () => {
  const app = await boot();
  const result = await app.call('memory_write', { kind: 'note', text: '偏好：直接执行', importance: 0.9 });
  assert.equal(result.value.kind, 'note');
  assert.equal(typeof result.value.id, 'number');
  assert.equal(result.value.deduped, false);
});

test('FR-01 duplicate note text in the same scope is deduplicated', async () => {
  const app = await boot();
  const first = await app.call('memory_write', { kind: 'note', text: '同一条结论', scope: 'proj:a' });
  const second = await app.call('memory_write', { kind: 'note', text: '同一条结论', scope: 'proj:a' });
  assert.equal(second.value.deduped, true);
  assert.equal(second.value.id, first.value.id);
});

test('FR-01 same text in a different scope is a separate row', async () => {
  const app = await boot();
  const first = await app.call('memory_write', { kind: 'note', text: '共享结论', scope: 'proj:a' });
  const second = await app.call('memory_write', { kind: 'note', text: '共享结论', scope: 'proj:b' });
  assert.equal(second.value.deduped, false);
  assert.notEqual(second.value.id, first.value.id);
});

test('FR-03 episode lands in the transcript layer', async () => {
  const app = await boot();
  await app.call('memory_write', { kind: 'episode', text: '一次观察记录' });
  const profile = await app.call('memory_profile');
  assert.equal(profile.value.stats.chunks, 1);
});

test('INV-01 identical episode text is stored once', async () => {
  const app = await boot();
  await app.call('memory_write', { kind: 'episode', text: '重复观察' });
  const again = await app.call('memory_write', { kind: 'episode', text: '重复观察' });
  assert.equal(again.value.deduped, true);
});

test('memory_write rejects an empty text', async () => {
  const app = await boot();
  await assert.rejects(() => app.call('memory_write', { kind: 'note', text: '   ' }));
});

test('memory_write rejects a fact without a subject', async () => {
  const app = await boot();
  await assert.rejects(() => app.call('memory_write', { kind: 'fact', text: 'x', object: 'y' }));
});
