import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { boot } from './helpers.mjs';

test('cased workspace paths share a key on Windows and macOS, case stays significant on Linux', async () => {
  const app = await boot();
  assert.equal(
    app.mod.projectKeyFromCwd('C:\\Work\\Repo', 'win32'),
    app.mod.projectKeyFromCwd('c:/work/repo/', 'win32'),
  );
  assert.equal(
    app.mod.projectKeyFromCwd('/Users/me/Repo', 'darwin'),
    app.mod.projectKeyFromCwd('/users/me/repo', 'darwin'),
  );
  assert.notEqual(
    app.mod.projectKeyFromCwd('/home/me/Repo', 'linux'),
    app.mod.projectKeyFromCwd('/home/me/repo', 'linux'),
  );
});

test('opening a legacy cased project merges its rows into the canonical scope', async () => {
  const app = await boot();
  const cwd = path.join(app.home, 'CasedProject');
  const legacy = app.mod.legacyProjectKeyFromCwd(cwd);
  const canonical = app.mod.projectKeyFromCwd(cwd);
  assert.notEqual(legacy, canonical);

  await app.call('memory_write', { kind: 'note', scope: legacy, text: 'P1Alias legacy row' });
  const resolved = app.mod.attachSession('alias-session', cwd);
  assert.equal(resolved, canonical);

  const search = await app.call('memory_search', { query: 'P1Alias', scope: 'project' });
  assert.equal(search.value.hits.length, 1);
  assert.equal(search.value.hits[0].scope, canonical);

  const db = new DatabaseSync(path.join(app.home, 'memory', 'omni.db'));
  const alias = db.prepare('SELECT canonical FROM scope_aliases WHERE alias = ?').get(legacy);
  assert.equal(alias.canonical, canonical);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notes WHERE scope = ?').get(legacy).n, 0);
  db.close();

  // Reopening under another spelling must be idempotent, not a second migration.
  app.mod.attachSession('alias-session-2', cwd.toUpperCase());
  const again = await app.call('memory_search', { query: 'P1Alias', scope: 'project' });
  assert.equal(again.value.hits.length, 1);
  assert.equal(again.value.hits[0].scope, canonical);
});

test('a duplicate active chunk is tombstoned at the source, never duplicated', async () => {
  const app = await boot();
  await app.call('memory_search', { query: 'warm-store' });
  const cwd = path.join(app.home, 'ChunkProject');
  const legacy = app.mod.legacyProjectKeyFromCwd(cwd);
  const canonical = app.mod.projectKeyFromCwd(cwd);
  const dbFile = path.join(app.home, 'memory', 'omni.db');

  const db = new DatabaseSync(dbFile);
  const insert = db.prepare('INSERT INTO chunks(ts, role, text, hash, scope) VALUES (?, ?, ?, ?, ?)');
  insert.run(Date.now(), 'user', 'old chunk body', 'same-hash', legacy);
  insert.run(Date.now(), 'user', 'new chunk body', 'same-hash', canonical);
  db.close();

  app.mod.attachSession('chunk-session', cwd);

  const after = new DatabaseSync(dbFile);
  const rows = after.prepare('SELECT scope, text, deleted_at FROM chunks WHERE hash = ? ORDER BY id').all('same-hash');
  assert.equal(rows.length, 2);
  assert.equal(rows.filter(row => row.deleted_at === null).length, 1);
  assert.equal(rows.find(row => row.deleted_at === null).scope, canonical);
  assert.equal(rows.find(row => row.scope === legacy).deleted_at !== null, true);
  after.close();
});
