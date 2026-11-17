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

function noteRow(home, id) {
  const db = dbOf(home);
  const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
  db.close();
  return row;
}

async function seedContradiction(app) {
  app.fire('assistant/message', '部署方式最终选择裸机进程方案', 1, 'safety-dream');
  const written = await app.call('memory_write', {
    kind: 'note', text: '部署方式最终选择 Docker 容器方案',
    source: 'session:safety-dream#1', importance: 0.9,
  });
  return written.value.id;
}

test('dream apply flags contradictions but never replaces by default', async () => {
  const app = await boot();
  const noteId = await seedContradiction(app);

  const run = await app.call('memory_dream', { apply: true });
  const action = run.value.actions.find(item => item.noteId === noteId);
  assert.equal(action.verdict, 'contradicted');
  assert.ok(action.proposedText, 'the proposal text is reported');

  const row = noteRow(app.home, noteId);
  assert.equal(row.superseded_by, null, 'default apply must not supersede');
  assert.equal(row.contested, 1, 'the note is flagged for review');
  assert.equal(row.verification, 'contradicted');
});

test('dream commit replaces only when explicitly requested', async () => {
  const app = await boot();
  const noteId = await seedContradiction(app);

  await app.call('memory_dream', { apply: true, commit: true });
  const row = noteRow(app.home, noteId);
  assert.ok(row.superseded_by, 'commit=true records the replacement');
  const replacement = noteRow(app.home, Number(row.superseded_by));
  assert.equal(replacement.deleted_at, null);
  assert.equal(replacement.source, `dream:${noteId}`);
});

test('proposals surface flagged notes with the evidence that would replace them', async () => {
  const app = await boot();
  const noteId = await seedContradiction(app);
  await app.call('memory_dream', { apply: true });

  const proposals = await app.call('memory_dream_proposals', {});
  const proposal = proposals.value.proposals.find(item => item.noteId === noteId);
  assert.ok(proposal, 'flagged note must be proposed');
  assert.equal(proposal.verdict, 'contradicted');
  assert.ok(proposal.proposedText.includes('裸机'), 'proposal text comes from the evidence');
});

test('replace requires confirm=true and is per-note', async () => {
  const app = await boot();
  const noteId = await seedContradiction(app);
  await app.call('memory_dream', { apply: true });

  await assert.rejects(
    app.call('memory_dream_replace', { noteId, confirm: false }),
    /confirm=true/,
  );
  const replaced = await app.call('memory_dream_replace', { noteId, confirm: true });
  assert.equal(replaced.value.oldId, noteId);
  const row = noteRow(app.home, noteId);
  assert.equal(row.superseded_by, replaced.value.replacementId);
});

test('rollback revives the original and tombstones the generated note', async () => {
  const app = await boot();
  const noteId = await seedContradiction(app);
  await app.call('memory_dream', { apply: true });
  const replaced = await app.call('memory_dream_replace', { noteId, confirm: true });

  const rolled = await app.call('memory_dream_rollback', { noteId });
  assert.equal(rolled.value.restored, true);
  assert.equal(rolled.value.replacementId, replaced.value.replacementId);

  const row = noteRow(app.home, noteId);
  assert.equal(row.superseded_by, null, 'original is active again');
  assert.equal(row.contested, 0);
  const replacement = noteRow(app.home, replaced.value.replacementId);
  assert.ok(replacement.deleted_at, 'generated replacement is tombstoned');

  const hits = await app.call('memory_search', { query: 'Docker', scope: 'all' });
  assert.ok(hits.value.hits.some(hit => hit.id === noteId && hit.kind === 'note'), 'original is searchable again');
});

test('rollback refuses replacements that dream did not create', async () => {
  const app = await boot();
  const noteId = await seedContradiction(app);
  const manual = await app.call('memory_write', { kind: 'note', text: '人工写入的替代结论', source: 'manual' });
  const db = dbOf(app.home);
  db.prepare('UPDATE notes SET superseded_by = ? WHERE id = ?').run(manual.value.id, noteId);
  db.close();

  const rolled = await app.call('memory_dream_rollback', { noteId });
  assert.equal(rolled.value.restored, false);
  assert.equal(rolled.value.reason, 'not a dream replacement');
});
