import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { boot } from './helpers.mjs';

test('NFR-04 committed rows survive a fresh handle on the same database', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-persist-'));
  const first = await boot({ home });
  await first.call('memory_write', { kind: 'note', text: '持久化验证条目', importance: 0.8 });

  const second = await boot({ home });
  const hit = await second.call('memory_search', { query: '持久化验证' });
  assert.equal(hit.value.hits.length, 1);
  assert.match(hit.value.hits[0].text, /持久化验证条目/);
});

test('NFR-04 the database file lives under DSH_HOME/memory', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-path-'));
  const app = await boot({ home });
  const profile = await app.call('memory_profile');
  assert.equal(profile.value.stats.db, 'omni.db');
  assert.equal(profile.value.stats.db.includes(home), false, 'stats must not disclose the absolute path');
});

test('NFR-06 forgetting keeps the audit row reachable by id', async () => {
  const app = await boot();
  const written = await app.call('memory_write', { kind: 'note', text: '审计可见性' });
  await app.call('memory_forget', { kind: 'note', id: written.value.id });
  const profile = await app.call('memory_profile');
  assert.equal(profile.value.stats.notes, 0, 'tombstoned rows are excluded from counts');
});
