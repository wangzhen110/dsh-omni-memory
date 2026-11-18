import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { boot, fakeReq, fakeRes } from './helpers.mjs';

const PROJECT_A = 'proj:leak#abc123';

function dbOf(home) {
  const db = new DatabaseSync(path.join(home, 'memory', 'omni.db'));
  db.exec('PRAGMA busy_timeout = 3000');
  return db;
}

test('profile facts never cross into an unknown project', async () => {
  const app = await boot();
  await app.call('memory_write', {
    kind: 'fact', scope: 'global', text: '全局实体 状态 全局值',
    subject: '全局实体', relation: '状态', object: '全局值',
  });
  await app.call('memory_write', {
    kind: 'fact', scope: PROJECT_A, text: '项目秘密 状态 项目秘密值',
    subject: '项目秘密', relation: '状态', object: '项目秘密值',
  });
  const text = app.section().text({ scope: { id: 'unknown-session' } });
  assert.ok(String(text).includes('全局值'), 'global facts stay visible');
  assert.equal(String(text).includes('项目秘密值'), false, 'project facts must not leak');
});

test('activeOnly export excludes superseded notes and expired facts', async () => {
  const app = await boot();
  const oldNote = await app.call('memory_write', { kind: 'note', scope: 'global', text: 'ActiveOld 旧结论' });
  const newNote = await app.call('memory_write', { kind: 'note', scope: 'global', text: 'ActiveNew 新结论' });
  const db = dbOf(app.home);
  db.prepare('UPDATE notes SET superseded_by = ? WHERE id = ?').run(newNote.value.id, oldNote.value.id);
  db.close();
  await app.call('memory_write', {
    kind: 'fact', scope: 'global', text: 'ActiveFact 状态 旧值',
    subject: 'ActiveFact', relation: '状态', object: '旧值',
  });
  await app.call('memory_write', {
    kind: 'fact', scope: 'global', text: 'ActiveFact 状态 新值',
    subject: 'ActiveFact', relation: '状态', object: '新值',
  });
  const file = path.join(app.home, 'active-only.json');
  const exported = await app.call('memory_export', { path: file, activeOnly: true });
  assert.equal(exported.value.counts.notes, 1);
  assert.equal(exported.value.counts.facts, 1);
  const snapshot = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(snapshot.notes.some(note => note.text.includes('ActiveOld')), false);
  assert.equal(snapshot.facts.some(fact => fact.object === '旧值'), false);
  assert.ok(snapshot.notes.some(note => note.text.includes('ActiveNew')));
  assert.ok(snapshot.facts.some(fact => fact.object === '新值'));
});

test('import restores cardinality, relations, aliases and persona', async () => {
  const source = await boot();
  await source.call('memory_write', {
    kind: 'fact', scope: 'global', text: '用户 喜欢 咖啡',
    subject: '用户', relation: '喜欢', object: '咖啡', cardinality: 'multi',
  });
  await source.call('memory_link_entity', { alias: '咖啡', canonical: '咖啡因', apply: true });
  await source.call('memory_persona', { action: 'set', values: { 称呼: '老王', 其他: '手工字段' } });
  const file = path.join(source.home, 'full-model.json');
  const exported = await source.call('memory_export', { path: file });
  assert.ok(exported.value.counts.relations >= 1);
  assert.ok(exported.value.counts.entityAliases >= 1);
  assert.ok(exported.value.counts.persona >= 2);

  const target = await boot();
  const imported = await target.call('memory_import', { path: file, dryRun: false });
  assert.equal(imported.value.relations, exported.value.counts.relations);
  assert.equal(imported.value.entityAliases, exported.value.counts.entityAliases);
  assert.equal(imported.value.persona, exported.value.counts.persona);

  const db = dbOf(target.home);
  const fact = db.prepare("SELECT cardinality FROM facts WHERE relation = '喜欢'").get();
  const relation = db.prepare("SELECT cardinality FROM relations WHERE name = '喜欢'").get();
  const alias = db.prepare("SELECT canonical FROM entity_aliases WHERE alias = '咖啡'").get();
  const persona = db.prepare("SELECT value FROM persona WHERE key = '其他'").get();
  db.close();
  assert.equal(fact.cardinality, 'multi');
  assert.equal(relation.cardinality, 'multi');
  assert.equal(alias.canonical, '咖啡因');
  assert.equal(persona.value, '手工字段');
});

test('chunk restore returns a structured conflict instead of a UNIQUE crash', async () => {
  const app = await boot();
  app.fire('user/message', 'RestoreConflict 同一段转录', 1, 'session-conflict');
  const db = dbOf(app.home);
  const old = db.prepare("SELECT id FROM chunks WHERE text LIKE 'RestoreConflict%'").get();
  db.close();
  await app.call('memory_forget', { kind: 'chunk', id: old.id });
  app.fire('user/message', 'RestoreConflict 同一段转录', 2, 'session-conflict');
  const restored = await app.call('memory_restore', { kind: 'chunk', id: old.id });
  assert.equal(restored.value.restored, false);
  assert.equal(restored.value.reason, 'active duplicate');
  assert.ok(restored.value.activeId > 0);
});

test('memory_reindex hashed mode respects the row limit', async () => {
  const app = await boot();
  for (let i = 0; i < 5; i += 1) {
    await app.call('memory_write', { kind: 'note', scope: 'global', text: `ReindexLimit ${i}` });
  }
  const db = dbOf(app.home);
  db.exec('DELETE FROM vectors');
  db.close();
  const result = await app.call('memory_reindex', { limit: 1 });
  assert.equal(result.value.processed, 1);
});

test('HTTP project scope searches every project but never global', async () => {
  const app = await boot();
  await app.call('memory_write', { kind: 'note', scope: 'global', text: 'ProjectScopeGlobal 全局命中' });
  await app.call('memory_write', { kind: 'note', scope: PROJECT_A, text: 'ProjectScopeProject 项目命中' });
  const res = fakeRes();
  await app.route('/omni-memory/search').handler(
    fakeReq('/omni-memory/search?q=ProjectScope&scope=project'), res.res,
  );
  assert.equal(res.state.statusCode, 200);
  const hits = res.json().hits;
  assert.ok(hits.some(hit => String(hit.text).includes('ProjectScopeProject')));
  assert.equal(hits.some(hit => String(hit.text).includes('ProjectScopeGlobal')), false);
  assert.ok(hits.every(hit => String(hit.scope ?? '').startsWith('proj:')));
});

test('list stats count active notes, not superseded history', async () => {
  const app = await boot();
  const oldNote = await app.call('memory_write', { kind: 'note', scope: 'global', text: 'StatsOld 旧' });
  const newNote = await app.call('memory_write', { kind: 'note', scope: 'global', text: 'StatsNew 新' });
  const db = dbOf(app.home);
  db.prepare('UPDATE notes SET superseded_by = ? WHERE id = ?').run(newNote.value.id, oldNote.value.id);
  db.close();
  const res = fakeRes();
  await app.route('/omni-memory/list').handler(fakeReq('/omni-memory/list'), res.res);
  const stats = res.json().stats;
  assert.equal(stats.notes, 1);
  assert.equal(stats.globalNotes, 1);
});
