import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { boot } from './helpers.mjs';

function factsOf(home) {
  const db = new DatabaseSync(path.join(home, 'memory', 'omni.db'));
  const rows = db.prepare('SELECT id, subject, relation, object, scope, valid_to, cardinality FROM facts ORDER BY id').all();
  db.close();
  return rows;
}

const PROJECT_A = 'proj:multi-a#aaa111';

test('single-valued relations still expire the previous value', async () => {
  const app = await boot();
  const first = await app.call('memory_write', {
    kind: 'fact', scope: 'global', text: '用户 所在地 北京', subject: '用户', relation: '所在地', object: '北京',
  });
  const second = await app.call('memory_write', {
    kind: 'fact', scope: 'global', text: '用户 所在地 上海', subject: '用户', relation: '所在地', object: '上海',
  });
  assert.equal(second.value.invalidated, 1);
  assert.equal(second.value.cardinality, 'single');

  const active = factsOf(app.home).filter(row => row.valid_to === null);
  assert.equal(active.length, 1);
  assert.equal(active[0].object, '上海');
  assert.equal(active[0].id, second.value.id);
  assert.notEqual(first.value.id, second.value.id);
});

test('multi-valued relations keep several active values', async () => {
  const app = await boot();
  const coffee = await app.call('memory_write', {
    kind: 'fact', scope: 'global', text: '用户 喜欢 咖啡',
    subject: '用户', relation: '喜欢', object: '咖啡', cardinality: 'multi',
  });
  const tea = await app.call('memory_write', {
    kind: 'fact', scope: 'global', text: '用户 喜欢 茶',
    subject: '用户', relation: '喜欢', object: '茶',
  });
  assert.equal(coffee.value.cardinality, 'multi');
  assert.equal(tea.value.cardinality, 'multi', 'the registry remembers the relation is multi');
  assert.equal(tea.value.invalidated, 0);

  const active = factsOf(app.home).filter(row => row.valid_to === null);
  assert.equal(active.length, 2);
  assert.deepEqual(active.map(row => row.object).sort(), ['咖啡', '茶']);

  const hits = await app.call('memory_search', { query: '用户 喜欢', scope: 'global', limit: 10 });
  const facts = hits.value.hits.filter(hit => hit.kind === 'fact').map(hit => hit.object);
  assert.ok(facts.includes('咖啡') && facts.includes('茶'), 'both values are retrievable');
});

test('multi-valued duplicate value is deduped, not duplicated', async () => {
  const app = await boot();
  const first = await app.call('memory_write', {
    kind: 'fact', scope: 'global', text: '用户 喜欢 咖啡',
    subject: '用户', relation: '喜欢', object: '咖啡', cardinality: 'multi',
  });
  const same = await app.call('memory_write', {
    kind: 'fact', scope: 'global', text: '用户 喜欢 咖啡',
    subject: '用户', relation: '喜欢', object: '咖啡',
  });
  assert.equal(same.value.deduped, true);
  assert.equal(same.value.id, first.value.id);
  const active = factsOf(app.home).filter(row => row.valid_to === null);
  assert.equal(active.length, 1);
});

test('multi-valued facts stay isolated by scope', async () => {
  const app = await boot();
  await app.call('memory_write', {
    kind: 'fact', scope: 'global', text: '部署环境 支持 容器',
    subject: '部署环境', relation: '支持', object: '容器', cardinality: 'multi',
  });
  await app.call('memory_write', {
    kind: 'fact', scope: PROJECT_A, text: '部署环境 支持 裸机',
    subject: '部署环境', relation: '支持', object: '裸机', cardinality: 'multi',
  });
  // A single-valued project write must not expire the global multi value.
  const projectSingle = await app.call('memory_write', {
    kind: 'fact', scope: PROJECT_A, text: '部署环境 默认 裸机',
    subject: '部署环境', relation: '默认', object: '裸机',
  });
  assert.equal(projectSingle.value.invalidated, 0);

  const active = factsOf(app.home).filter(row => row.valid_to === null);
  assert.ok(active.some(row => row.scope === 'global' && row.object === '容器'));
  assert.ok(active.some(row => row.scope === PROJECT_A && row.object === '裸机'));

  const globalHits = await app.call('memory_search', { query: '部署环境 支持', scope: 'global', limit: 10 });
  assert.equal(globalHits.value.hits.some(hit => hit.kind === 'fact' && hit.object === '裸机'), false, 'project fact must not leak');
});
