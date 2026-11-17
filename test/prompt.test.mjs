import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

test('FR-09 the prompt section is registered under omni-memory', async () => {
  const app = await boot();
  const section = app.section();
  assert.ok(section, 'prompt section missing');
  assert.equal(section.name, 'omni-memory');
  assert.equal(typeof section.text, 'function');
});

test('FR-09 an empty store injects no characters at all', async () => {
  const app = await boot();
  assert.equal(app.section().text(), '');
});

test('FR-09 the injected text stays within the 1200 character budget', async () => {
  const app = await boot();
  await app.call('memory_write', {
    kind: 'note',
    text: `预算测试条目 ${'填充'.repeat(240)}`,
    importance: 1,
  });
  const text = app.section().text();
  assert.ok(text.length > 0);
  assert.ok(text.length <= 1200, `injected ${text.length} chars`);
});

test('FR-10 a write invalidates the cached profile immediately', async () => {
  const app = await boot();
  await app.call('memory_write', { kind: 'note', text: '第一条结论' });
  assert.match(app.section().text(), /第一条结论/);
  await app.call('memory_write', { kind: 'note', text: '第二条结论' });
  assert.match(app.section().text(), /第二条结论/);
});

test('FR-10 a forgotten note disappears from the injected profile', async () => {
  const app = await boot();
  const written = await app.call('memory_write', { kind: 'note', text: '会被遗忘的结论' });
  assert.match(app.section().text(), /会被遗忘的结论/);
  await app.call('memory_forget', { kind: 'note', id: written.value.id });
  assert.equal(app.section().text().includes('会被遗忘的结论'), false);
});

test('NFR-02 repeated reads reuse the cache instead of re-reading notes', async () => {
  const app = await boot();
  await app.call('memory_write', { kind: 'note', text: '缓存命中测试' });
  const first = app.section().text();
  const second = app.section().text();
  assert.equal(first, second);
});
