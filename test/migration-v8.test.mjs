import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { boot } from './helpers.mjs';

test('a v7 database upgrades to v11 with the cardinality column and relations table', async () => {
  const app = await boot();
  await app.call('memory_profile');
  const dbFile = path.join(app.home, 'memory', 'omni.db');
  // Simulate a v7 store: drop the v8 artifacts and claim version 7.
  const db = new DatabaseSync(dbFile);
  db.exec('DROP TABLE IF EXISTS relations');
  try { db.exec('ALTER TABLE facts DROP COLUMN cardinality'); } catch { /* older sqlite */ }
  db.prepare("UPDATE meta SET value = '7' WHERE key = 'schema_version'").run();
  db.close();

  const again = await boot({ home: app.home });
  await again.call('memory_profile');
  const migrated = new DatabaseSync(dbFile);
  const columns = migrated.prepare('PRAGMA table_info(facts)').all().map(row => row.name);
  const relations = migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'relations'").get();
  const version = migrated.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
  migrated.close();
  assert.ok(columns.includes('cardinality'), 'cardinality column added');
  assert.ok(relations, 'relations registry created');
  assert.equal(version, String(again.mod.SCHEMA_VERSION));
  assert.ok(again);
});

test('a database whose marker claims v10 but lacks the column is repaired', async () => {
  const app = await boot();
  await app.call('memory_profile');
  const dbFile = path.join(app.home, 'memory', 'omni.db');
  const db = new DatabaseSync(dbFile);
  db.exec('DROP TABLE IF EXISTS relations');
  try { db.exec('ALTER TABLE facts DROP COLUMN cardinality'); } catch { /* ignore */ }
  // Marker stays 8 on purpose (this is the state the ordering bug produced).
  db.close();

  const reopened = await boot({ home: app.home });
  await reopened.call('memory_profile');
  const repaired = new DatabaseSync(dbFile);
  const columns = repaired.prepare('PRAGMA table_info(facts)').all().map(row => row.name);
  repaired.close();
  assert.ok(columns.includes('cardinality'), 'repair path restores the missing column');
});
