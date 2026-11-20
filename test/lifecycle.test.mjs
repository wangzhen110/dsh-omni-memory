import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { boot, fakeReq, fakeRes } from './helpers.mjs';

/**
 * Lifecycle matrix.
 *
 * Every read path must answer one question the same way: "which rows are active
 * for this scope?" The first review found that superseded notes and expired facts
 * leaked through several of them, because each query had its own WHERE clause.
 * These cases pin the matrix so a new reader cannot quietly reintroduce a leak:
 *
 *   row state: active | superseded | expired | contested | tombstoned
 *   layer:     global | project-a | project-b
 *   readers:   search | profile | graph | node | list | vector (same search call)
 */

function dbOf(app) {
  const db = new DatabaseSync(path.join(app.home, 'memory', 'omni.db'));
  db.exec('PRAGMA busy_timeout = 3000');
  return db;
}

const PROJECT_A = 'proj:alpha#aaa111';
const PROJECT_B = 'proj:beta#bbb222';

async function seed(app) {
  const active = await app.call('memory_write', { kind: 'note', scope: 'global', text: 'LifeActive global 活跃结论' });
  const superseded = await app.call('memory_write', { kind: 'note', scope: 'global', text: 'LifeOld global 已被替代的旧结论' });
  const tombstoned = await app.call('memory_write', { kind: 'note', scope: 'global', text: 'LifeGone global 已墓碑的结论' });
  const contested = await app.call('memory_write', { kind: 'note', scope: 'global', text: 'LifeContest global 有争议的结论' });
  const projectNote = await app.call('memory_write', { kind: 'note', scope: PROJECT_A, text: 'LifeAlpha A项目专属结论' });
  const foreignNote = await app.call('memory_write', { kind: 'note', scope: PROJECT_B, text: 'LifeBeta B项目专属结论' });

  // Supersede with a replacement row that stays active.
  await app.call('memory_write', { kind: 'note', scope: 'global', text: 'LifeReplacement 替代后的新结论' });
  const db = dbOf(app);
  const replacement = db.prepare("SELECT id FROM notes WHERE text LIKE 'LifeReplacement%'").get();
  db.prepare('UPDATE notes SET superseded_by = ? WHERE id = ?').run(Number(replacement.id), superseded.value.id);
  db.prepare('UPDATE notes SET contested = 1 WHERE id = ?').run(contested.value.id);
  db.close();
  await app.call('memory_forget', { kind: 'note', id: tombstoned.value.id });

  const expired = await app.call('memory_write', {
    kind: 'fact', scope: 'global', text: 'LifeDeploy 方案 Docker', subject: 'LifeDeploy', relation: '方案', object: 'Docker',
  });
  const fresh = await app.call('memory_write', {
    kind: 'fact', scope: 'global', text: 'LifeDeploy 方案 裸机', subject: 'LifeDeploy', relation: '方案', object: '裸机',
  });
  const projectFact = await app.call('memory_write', {
    kind: 'fact', scope: PROJECT_A, text: 'LifeDeploy 方案 项目容器', subject: 'LifeDeploy', relation: '方案', object: '项目容器',
  });

  return { active, superseded, tombstoned, contested, projectNote, foreignNote, expired, fresh, projectFact };
}

test('lifecycle matrix: search never returns superseded, tombstoned or out-of-scope notes', async () => {
  const app = await boot();
  const rows = await seed(app);

  const globalHits = (await app.call('memory_search', { query: 'Life', scope: 'global', limit: 30 })).value.hits;
  const ids = globalHits.filter(hit => hit.kind === 'note').map(hit => hit.id);
  assert.ok(!ids.includes(rows.superseded.value.id), 'superseded note leaked into search');
  assert.ok(!ids.includes(rows.tombstoned.value.id), 'tombstoned note leaked into search');
  assert.ok(!ids.includes(rows.projectNote.value.id), 'project note leaked into global search');
  assert.ok(!ids.includes(rows.foreignNote.value.id), 'foreign project note leaked into global search');
  assert.ok(ids.includes(rows.active.value.id), 'active note missing');

  const projectHits = (await app.call('memory_search', { query: 'Life', scope: PROJECT_A, limit: 30 })).value.hits;
  const projectIds = projectHits.map(hit => hit.id);
  assert.ok(projectIds.includes(rows.projectNote.value.id), 'own project note missing');
  assert.ok(!projectIds.includes(rows.foreignNote.value.id), 'foreign project note leaked into project search');
});

test('lifecycle matrix: profile excludes contested and superseded notes', async () => {
  const app = await boot();
  const rows = await seed(app);

  const profile = await app.call('memory_profile', { scope: 'global' });
  assert.ok(profile.text.includes('LifeActive'), 'active note missing from profile');
  assert.ok(!profile.text.includes('LifeOld'), 'superseded note leaked into profile');
  assert.ok(!profile.text.includes('LifeContest'), 'contested note leaked into profile');
  assert.ok(!profile.text.includes('LifeBeta'), 'foreign project note leaked into global profile');

  const projectProfile = await app.call('memory_profile', { scope: PROJECT_A });
  assert.ok(projectProfile.text.includes('LifeAlpha'), 'project note missing from project profile');
  assert.ok(!projectProfile.text.includes('LifeBeta'), 'foreign project note leaked into project profile');
});

test('lifecycle matrix: expired facts leave search, timeline keeps the history', async () => {
  const app = await boot();
  const rows = await seed(app);

  const hits = (await app.call('memory_search', { query: 'Docker', scope: 'global', limit: 20 })).value.hits;
  assert.ok(!hits.some(hit => hit.kind === 'fact' && hit.id === rows.expired.value.id), 'expired fact leaked into search');

  const timeline = await app.call('memory_timeline', { entity: 'LifeDeploy', scope: 'all' });
  assert.ok(timeline.text.includes('Docker'), 'timeline should retain the old value for audit');
  assert.ok(timeline.text.includes('裸机'), 'timeline should show the current value');
});

test('lifecycle matrix: contested facts stay out of profile and persona evidence', async () => {
  const app = await boot();
  const fact = await app.call('memory_write', {
    kind: 'fact', scope: 'global', text: 'LifeSecretState 有争议的机密状态', subject: 'LifeSecretState', relation: '状态', object: '机密',
  });
  const db = dbOf(app);
  db.prepare('UPDATE facts SET contested = 1 WHERE id = ?').run(fact.value.id);
  db.close();

  const profile = await app.call('memory_profile', { scope: 'global' });
  assert.ok(!profile.text.includes('LifeSecretState'), 'contested fact leaked into profile');
  const refreshed = await app.call('memory_persona', { action: 'refresh' });
  assert.ok(!JSON.stringify(refreshed.value.persona).includes('LifeSecretState'), 'contested fact leaked into persona');
});

test('lifecycle matrix: graph and node routes respect active state and scope', async () => {
  const app = await boot();
  const rows = await seed(app);

  const globalGraph = fakeRes();
  await app.route('/omni-memory/graph').handler(fakeReq('/omni-memory/graph?scope=global'), globalGraph.res);
  const graph = globalGraph.json();
  const labels = graph.nodes.map(node => String(node.label));
  assert.ok(!labels.some(label => label.includes('LifeOld')), 'superseded note leaked into graph');
  assert.ok(!labels.some(label => label.includes('LifeAlpha')), 'project note leaked into global graph');

  const nodeGlobal = fakeRes();
  await app.route('/omni-memory/node').handler(
    fakeReq(`/omni-memory/node?node=n:${rows.projectNote.value.id}&scope=global`), nodeGlobal.res,
  );
  assert.equal(nodeGlobal.state.statusCode, 404, 'project node must not open from the global layer');

  const nodeProject = fakeRes();
  await app.route('/omni-memory/node').handler(
    fakeReq(`/omni-memory/node?node=n:${rows.projectNote.value.id}&scope=${encodeURIComponent(PROJECT_A)}`), nodeProject.res,
  );
  assert.equal(nodeProject.state.statusCode, 200, 'project node must open from its own layer');

  const nodeSuperseded = fakeRes();
  await app.route('/omni-memory/node').handler(
    fakeReq(`/omni-memory/node?node=n:${rows.superseded.value.id}&scope=global`), nodeSuperseded.res,
  );
  assert.equal(nodeSuperseded.state.statusCode, 404, 'superseded node must not open');
});

test('lifecycle matrix: list route hides tombstoned rows and scopes project chunks', async () => {
  const app = await boot();
  const rows = await seed(app);

  const all = fakeRes();
  await app.route('/omni-memory/list').handler(fakeReq('/omni-memory/list?limit=30&scope=all'), all.res);
  const body = all.json();
  const noteIds = body.notes.map(note => note.id);
  assert.ok(!noteIds.includes(rows.tombstoned.value.id), 'tombstoned note leaked into list');
  assert.ok(!noteIds.includes(rows.superseded.value.id), 'superseded note leaked into list');

  const project = fakeRes();
  await app.route('/omni-memory/list').handler(
    fakeReq(`/omni-memory/list?limit=30&scope=${encodeURIComponent(PROJECT_A)}`), project.res,
  );
  const projectNotes = project.json().notes.map(note => note.text);
  assert.ok(projectNotes.some(text => text.includes('LifeAlpha')));
  assert.ok(!projectNotes.some(text => text.includes('LifeBeta')));
});

test('lifecycle matrix: a re-captured transcript is searchable, the tombstone is not', async () => {
  const app = await boot();
  const text = 'LifeChunk 生命周期转录内容';
  app.fire('user/message', text, 1, 'session-life');

  const db = dbOf(app);
  const first = db.prepare('SELECT id FROM chunks WHERE text = ? AND deleted_at IS NULL').get(text);
  db.close();
  await app.call('memory_forget', { kind: 'chunk', id: first.id });
  app.fire('user/message', text, 2, 'session-life');

  const hits = (await app.call('memory_search', { query: 'LifeChunk', scope: 'all', limit: 20 })).value.hits;
  const chunkHits = hits.filter(hit => hit.kind === 'chunk');
  assert.ok(chunkHits.length >= 1, 're-captured chunk should be searchable');
  assert.ok(chunkHits.every(hit => hit.id !== first.id), 'tombstoned chunk must not be searchable');
});

test('lifecycle matrix: written rows carry a resolvable scope in the database', async () => {
  const app = await boot();
  const rows = await seed(app);
  const db = dbOf(app);
  const scopes = db.prepare('SELECT id, scope FROM notes WHERE id IN (?, ?, ?)')
    .all(rows.active.value.id, rows.projectNote.value.id, rows.foreignNote.value.id);
  db.close();
  const byId = new Map(scopes.map(row => [row.id, row.scope]));
  assert.equal(byId.get(rows.active.value.id), 'global');
  assert.equal(byId.get(rows.projectNote.value.id), PROJECT_A);
  assert.equal(byId.get(rows.foreignNote.value.id), PROJECT_B);
});
