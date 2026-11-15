import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { boot } from './helpers.mjs';

function readNote(home, id) {
  const db = new DatabaseSync(path.join(home, 'memory', 'omni.db'));
  const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
  db.close();
  return row;
}

test('FR-20 a correct note is verified as supported', async () => {
  const app = await boot();
  app.fire('assistant/message', '部署方式最终选择裸机进程方案，便于直接调进程', 1, 'dream');
  await app.call('memory_write', {
    kind: 'note',
    text: '部署方式最终选择裸机进程方案',
    source: 'session:dream#1',
    importance: 0.9,
  });
  const dream = await app.call('memory_dream', { apply: true });
  const action = dream.value.actions.find(item => item.verdict !== undefined);
  assert.equal(action.verdict, 'supported');
  const row = readNote(app.home, action.noteId);
  assert.equal(row.verification, 'supported');
});

test('FR-20 a note contradicted by its transcript is flagged and superseded', async () => {
  const app = await boot();
  app.fire('assistant/message', '部署方式最终选择裸机进程方案，便于直接调进程', 1, 'dream');
  const written = await app.call('memory_write', {
    kind: 'note',
    text: '部署方式最终选择 Docker 容器方案',
    source: 'session:dream#1',
    importance: 0.9,
  });

  const dry = await app.call('memory_dream', {});
  const dryAction = dry.value.actions.find(item => item.noteId === written.value.id);
  assert.equal(dryAction.verdict, 'contradicted');
  assert.deepEqual(dryAction.missingTokens, ['docker']);
  assert.equal(readNote(app.home, written.value.id).verification, null, 'dry run must not write');

  const applied = await app.call('memory_dream', { apply: true });
  const action = applied.value.actions.find(item => item.noteId === written.value.id);
  assert.equal(action.verdict, 'contradicted');
  assert.equal(typeof action.replacementId, 'number');

  const oldRow = readNote(app.home, written.value.id);
  assert.equal(oldRow.verification, 'contradicted');
  assert.equal(oldRow.contested, 1);
  assert.equal(oldRow.superseded_by, action.replacementId);

  const replacement = readNote(app.home, action.replacementId);
  assert.match(replacement.text, /裸机进程方案/);
  assert.equal(replacement.source, `dream:${written.value.id}`);
  assert.equal(replacement.revision, 2);
});

test('FR-20 a note with no evidence is reported as no_source', async () => {
  const app = await boot();
  const written = await app.call('memory_write', {
    kind: 'note', text: '完全没有任何来源的孤立结论', importance: 0.5,
  });
  const dream = await app.call('memory_dream', {});
  const action = dream.value.actions.find(item => item.noteId === written.value.id);
  assert.equal(action.verdict, 'no_source');
  assert.equal(action.evidence, null);
});

test('FR-20 a superseded note is not verified twice', async () => {
  const app = await boot();
  app.fire('assistant/message', '缓存策略最终采用内存缓存', 1, 'dream2');
  await app.call('memory_write', {
    kind: 'note', text: '缓存策略最终采用磁盘缓存', source: 'session:dream2#1', importance: 0.9,
  });
  await app.call('memory_dream', { apply: true });
  const second = await app.call('memory_dream', { apply: true });
  assert.equal(second.value.actions.some(item => item.verdict === 'contradicted'), false);
});

test('FR-20 dream writes an evidence pointer for every applied verdict', async () => {
  const app = await boot();
  app.fire('assistant/message', '记忆库固定放在 DSH_HOME 下面', 1, 'dream3');
  const written = await app.call('memory_write', {
    kind: 'note', text: '记忆库固定放在 DSH_HOME 下面', source: 'session:dream3#1',
  });
  await app.call('memory_dream', { apply: true });
  const row = readNote(app.home, written.value.id);
  assert.equal(row.evidence, 'session:dream3#1');
  assert.equal(typeof row.verified_at, 'number');
});
