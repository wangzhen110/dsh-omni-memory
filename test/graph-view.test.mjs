import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, fakeReq, fakeRes } from './helpers.mjs';

async function graphOf(app, url = '/omni-memory/graph') {
  const { res, json } = fakeRes();
  await app.route('/omni-memory/graph').handler(fakeReq(url), res);
  return json();
}

test('FR-29 the graph route turns facts into entity stars and edges', async () => {
  const app = await boot();
  await app.call('memory_write', {
    kind: 'fact', subject: '星图', relation: '连接', object: '笔记', text: '星图 连接 笔记', scope: 'global',
  });
  const body = await graphOf(app);
  assert.equal(body.ok, true);
  const entities = body.nodes.filter(node => node.kind === 'entity');
  assert.ok(entities.some(node => node.label === '星图'));
  assert.ok(entities.some(node => node.label === '笔记'));
  assert.ok(body.links.some(link => link.source === 'e:星图' && link.target === 'e:笔记'));
});

test('FR-29 notes are attached to the entities they mention', async () => {
  const app = await boot();
  await app.call('memory_write', {
    kind: 'fact', subject: '星图', relation: '连接', object: '笔记', text: '星图 连接 笔记', scope: 'global',
  });
  const note = await app.call('memory_write', {
    kind: 'note', text: '星图里每个节点都值得保留', scope: 'global',
  });
  const body = await graphOf(app);
  const noteNode = body.nodes.find(node => node.id === `n:${note.value.id}`);
  assert.ok(noteNode, 'the note must be a node');
  assert.ok(body.links.some(link => link.source === noteNode.id && link.target === 'e:星图'));
});

test('FR-29 the graph stays bounded and never returns dangling links', async () => {
  const app = await boot();
  for (let i = 0; i < 30; i += 1) {
    await app.call('memory_write', {
      kind: 'fact', subject: `实体${i}`, relation: '指向', object: `目标${i}`, text: `实体${i} 指向 目标${i}`, scope: 'global',
    });
  }
  const body = await graphOf(app);
  const ids = new Set(body.nodes.map(node => node.id));
  assert.ok(body.nodes.length <= 300, 'node count must stay bounded');
  for (const link of body.links) {
    assert.ok(ids.has(link.source), `dangling source ${link.source}`);
    assert.ok(ids.has(link.target), `dangling target ${link.target}`);
  }
});

test('FR-29 an empty memory returns an empty graph instead of failing', async () => {
  const app = await boot();
  const body = await graphOf(app);
  assert.equal(body.ok, true);
  assert.deepEqual(body.nodes, []);
  assert.deepEqual(body.links, []);
});

test('FR-29 the graph route is loopback only', async () => {
  const app = await boot();
  const { res, state } = fakeRes();
  await app.route('/omni-memory/graph').handler(fakeReq('/omni-memory/graph', '8.8.8.8'), res);
  assert.equal(state.statusCode, 403);
});

test('FR-29 the graph keeps a global map and one map per project', async () => {
  const app = await boot();
  await app.call('memory_write', {
    kind: 'fact', subject: '全局甲', relation: '指向', object: '全局乙',
    text: '全局甲 指向 全局乙', scope: 'global',
  });
  await app.call('memory_write', {
    kind: 'fact', subject: '项目甲', relation: '包含', object: '条目乙',
    text: '项目甲 包含 条目乙', scope: 'proj:alpha#abc123',
  });

  const globalMap = await graphOf(app, '/omni-memory/graph?scope=global');
  const labels = globalMap.nodes.map(node => node.label);
  assert.ok(labels.includes('全局甲'));
  assert.equal(labels.includes('项目甲'), false, 'global map must not contain project stars');
  assert.ok(globalMap.scopes.some(scope => scope.key === 'global'));
  assert.ok(globalMap.scopes.some(scope => scope.key === 'proj:alpha#abc123'));

  const projectMap = await graphOf(app, '/omni-memory/graph?scope=' + encodeURIComponent('proj:alpha#abc123'));
  const projectLabels = projectMap.nodes.map(node => node.label);
  assert.ok(projectLabels.includes('项目甲'));
  assert.equal(projectLabels.includes('全局甲'), false, 'project map must not contain global stars');
  assert.equal(projectMap.scope, 'proj:alpha#abc123');
});
