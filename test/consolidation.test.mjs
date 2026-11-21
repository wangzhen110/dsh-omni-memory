import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

async function write(app, overrides = {}) {
  return app.call('memory_write', {
    kind: 'note',
    text: 'placeholder',
    scope: 'proj:alpha',
    ...overrides,
  });
}

test('consolidation is a dry run by default and preserves the status groups', async () => {
  const app = await boot();
  const ok = await write(app, { text: '修复 A：先停服务再迁移。', problemKey: 'fp:migrate', solutionStatus: 'verified' });
  const bad = await write(app, { text: '尝试 B：直接迁移会锁库。', problemKey: 'FP:MIGRATE', solutionStatus: 'failed' });
  const unknown = await write(app, { text: '尝试 C：尚未复现。', problemKey: 'fp:migrate', solutionStatus: 'unverified' });

  const result = await app.call('memory_consolidate', { problemKey: ' fp:migrate ', scope: 'proj:alpha' });
  assert.equal(result.value.applied, false);
  assert.equal(result.value.notes, 3);
  assert.deepEqual(result.value.sourceIds, [ok.value.id, bad.value.id, unknown.value.id]);
  assert.match(result.value.summary, /已验证/);
  assert.match(result.value.summary, /失败尝试/);
  assert.match(result.value.summary, /未验证/);

  const profile = await app.call('memory_profile', { scope: 'proj:alpha' });
  assert.equal(profile.value.stats.notes, 3);
});

test('apply writes one source-linked summary and supersedes the inputs', async () => {
  const app = await boot();
  const ok = await write(app, { text: '修复 A：先停服务再迁移。', problemKey: 'fp:migrate', solutionStatus: 'verified', importance: 0.8 });
  const bad = await write(app, { text: '尝试 B：直接迁移会锁库。', problemKey: 'fp:migrate', solutionStatus: 'failed', importance: 0.5 });

  await app.call('memory_feedback', { kind: 'note', id: ok.value.id, rating: 'useful', scope: 'all' });
  await app.call('memory_feedback', { kind: 'note', id: bad.value.id, rating: 'misleading', scope: 'all' });
  const result = await app.call('memory_consolidate', { problemKey: 'fp:migrate', scope: 'proj:alpha', apply: true });
  assert.equal(result.value.applied, true);
  assert.ok(result.value.noteId > 0);
  const summary = await app.call('memory_get', { items: [{ kind: 'note', id: result.value.noteId }], scope: 'proj:alpha' });
  assert.match(summary.value.items[0].source, /^consolidate:/);
  assert.equal(summary.value.items[0].solutionStatus, 'verified');
  assert.match(summary.value.items[0].evidence, /n:1/);
  assert.match(summary.value.items[0].text, /修复 A/);
  assert.match(summary.value.items[0].text, /尝试 B/);
  assert.equal(summary.value.items[0].feedbackCount, 2);
  assert.equal(summary.value.items[0].usefulCount, 1);
  assert.equal(summary.value.items[0].misleadingCount, 1);

  const old = await app.call('memory_get', { items: [{ kind: 'note', id: ok.value.id }, { kind: 'note', id: bad.value.id }], scope: 'proj:alpha' });
  assert.equal(old.value.items.length, 0);
  assert.equal(old.value.missing.length, 2);

  const profile = await app.call('memory_profile', { scope: 'proj:alpha' });
  assert.match(profile.value.text, /## 当前项目/);
  assert.match(profile.value.text, /问题 fp:migrate/);
});

test('consolidation never crosses an exact scope', async () => {
  const app = await boot();
  await write(app, { text: 'Alpha one', problemKey: 'fp:scope', scope: 'proj:alpha' });
  await write(app, { text: 'Alpha two', problemKey: 'fp:scope', scope: 'proj:alpha' });
  await write(app, { text: 'Beta one', problemKey: 'fp:scope', scope: 'proj:beta' });
  const alpha = await app.call('memory_consolidate', { problemKey: 'fp:scope', scope: 'proj:alpha' });
  assert.equal(alpha.value.notes, 2);
  const beta = await app.call('memory_consolidate', { problemKey: 'fp:scope', scope: 'proj:beta' });
  assert.equal(beta.value.notes, 1);
  assert.match(beta.value.reason ?? '', /not enough/);
});

test('consolidation rejects scope=all and reports too few notes without writing', async () => {
  const app = await boot();
  await assert.rejects(() => app.call('memory_consolidate', { problemKey: 'fp:x', scope: 'all' }), /exact scope/);
  await write(app, { text: 'Only one', problemKey: 'fp:one', scope: 'proj:alpha' });
  const result = await app.call('memory_consolidate', { problemKey: 'fp:one', scope: 'proj:alpha', apply: true });
  assert.equal(result.value.applied, false);
  assert.match(result.value.reason, /not enough/);
});

