import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { boot } from './helpers.mjs';

function dbOf(home) {
  const db = new DatabaseSync(path.join(home, 'memory', 'omni.db'));
  db.exec('PRAGMA busy_timeout = 3000');
  return db;
}

test('entity names are normalised at write time', async () => {
  const app = await boot();
  const upper = await app.call('memory_write', {
    kind: 'fact', scope: 'global', text: 'Deploy 方式 容器', subject: 'Deploy', relation: '方式', object: '容器',
  });
  const lower = await app.call('memory_write', {
    kind: 'fact', scope: 'global', text: 'deploy 方式 裸机', subject: 'deploy', relation: '方式', object: '裸机',
  });
  const db = dbOf(app.home);
  const subjects = db.prepare('SELECT DISTINCT subject FROM facts').all().map(row => row.subject);
  db.close();
  assert.deepEqual(subjects, ['deploy']);
  assert.equal(upper.value.id !== undefined, true);
  assert.equal(lower.value.invalidated, 1, 'single-valued relation still expires the old value under the canonical subject');
});

test('link entity is a dry run until apply=true', async () => {
  const app = await boot();
  await app.call('memory_write', {
    kind: 'fact', scope: 'global', text: '上线 方式 容器', subject: '上线', relation: '方式', object: '容器',
  });
  const dry = await app.call('memory_link_entity', { alias: '上线', canonical: '部署' });
  assert.equal(dry.value.applied, false);
  assert.equal(dry.value.affectedFacts, 1);

  const db = dbOf(app.home);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM facts WHERE subject = '上线'").get().n, 1, 'dry run must not rewrite');
  db.close();
});

test('link entity merges facts and edges into the canonical name', async () => {
  const app = await boot();
  await app.call('memory_write', {
    kind: 'fact', scope: 'global', text: '上线 方式 容器', subject: '上线', relation: '方式', object: '容器',
  });
  const applied = await app.call('memory_link_entity', { alias: '上线', canonical: '部署', apply: true });
  assert.equal(applied.value.applied, true);
  assert.equal(applied.value.canonical, '部署');

  const db = dbOf(app.home);
  const subjects = db.prepare('SELECT DISTINCT subject FROM facts').all().map(row => row.subject);
  const edges = db.prepare("SELECT src FROM edges WHERE rel = '方式'").all().map(row => row.src);
  const alias = db.prepare("SELECT canonical FROM entity_aliases WHERE alias = '上线'").get();
  db.close();
  assert.deepEqual(subjects, ['部署']);
  assert.ok(edges.every(src => src === '部署'));
  assert.equal(alias?.canonical, '部署');

  const timeline = await app.call('memory_timeline', { entity: '部署', scope: 'all' });
  assert.ok(timeline.text.includes('容器'), 'merged fact is visible under the canonical entity');

  const second = await app.call('memory_write', {
    kind: 'fact', scope: 'global', text: '上线 方式 裸机', subject: '上线', relation: '方式', object: '裸机',
  });
  const after = dbOf(app.home);
  const stored = after.prepare('SELECT DISTINCT subject FROM facts').all().map(row => row.subject);
  after.close();
  assert.deepEqual(stored, ['部署'], 'future writes through the alias land on the canonical subject');
  assert.equal(second.value.invalidated, 1);
});

test('profile shows every active value of a multi-valued relation', async () => {
  const app = await boot();
  await app.call('memory_write', {
    kind: 'fact', scope: 'global', text: '用户 喜欢 咖啡', subject: '用户', relation: '喜欢', object: '咖啡', cardinality: 'multi', importance: 0.9,
  });
  await app.call('memory_write', {
    kind: 'fact', scope: 'global', text: '用户 喜欢 茶', subject: '用户', relation: '喜欢', object: '茶', cardinality: 'multi',
  });
  const profile = await app.call('memory_profile', { scope: 'global' });
  assert.ok(profile.text.includes('相关事实'), 'facts section is present');
  assert.ok(profile.text.includes('咖啡') && profile.text.includes('茶'), 'both values in the profile');
});
