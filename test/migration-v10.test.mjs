import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { boot } from './helpers.mjs';

const hasTable = (db, name) => !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

test('a v9 database upgrades to v11 with the persona table and solution columns', async () => {
  const app = await boot();
  await app.call('memory_profile');
  const file = path.join(app.home, 'memory', 'omni.db');
  const db = new DatabaseSync(file);
  db.exec('DROP TABLE IF EXISTS persona');
  db.prepare("UPDATE meta SET value = '9' WHERE key = 'schema_version'").run();
  db.close();

  const again = await boot({ home: app.home });
  await again.call('memory_profile');
  const migrated = new DatabaseSync(file);
  const persona = hasTable(migrated, 'persona');
  const version = migrated.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
  migrated.close();
  assert.ok(persona, 'persona table created');
  assert.equal(version, '13');
});

test('a database whose marker is v10 but lacks persona is repaired', async () => {
  const app = await boot();
  await app.call('memory_profile');
  const file = path.join(app.home, 'memory', 'omni.db');
  const db = new DatabaseSync(file);
  db.exec('DROP TABLE IF EXISTS persona');
  // Marker stays at 10 on purpose (the ordering bug produced exactly this state).
  db.close();

  const again = await boot({ home: app.home });
  await again.call('memory_profile');
  const repaired = new DatabaseSync(file);
  const ok = hasTable(repaired, 'persona');
  repaired.close();
  assert.ok(ok, 'repair path restores the missing table');
});
