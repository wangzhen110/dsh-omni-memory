import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, fakePost, fakeRes } from './helpers.mjs';

test('memory_ingest stores a transcript and parks pending candidates', async () => {
  const app = await boot();
  const result = await app.call('memory_ingest', {
    text: '以后部署必须记住：先看 health，再发布 7788 端口。',
    role: 'user',
    scope: 'global',
  });
  assert.equal(result.value.deduped, false);
  assert.equal(result.value.chars > 0, true);
  assert.equal(result.value.candidates.length, 1);
  const queue = await app.call('memory_candidate', { action: 'list', scope: 'global' });
  assert.equal(queue.value.action, 'list');
  assert.equal(queue.value.total, 1);
  assert.match(queue.value.candidates[0].text, /7788/);
});

test('scope=all guard is case-insensitive for transcripts', async () => {
  const app = await boot();
  for (const scope of ['ALL', 'All']) {
    await assert.rejects(
      () => app.call('memory_ingest', { text: '记住：这条不应写入。', role: 'user', scope }),
      /scope=all/,
    );
  }
});

test('candidate acceptance writes a normal note with provenance', async () => {
  const app = await boot();
  const result = await app.call('memory_ingest', {
    text: '记住：全息记忆的候选队列先确认再入库。',
    role: 'user',
    scope: 'global',
  });
  const candidate = result.value.candidates[0];
  assert.ok(candidate, 'expected a candidate');
  const accepted = await app.call('memory_candidate', {
    action: 'accept', id: candidate.id, scope: 'global',
  });
  assert.equal(accepted.value.status, 'accepted');
  assert.ok(accepted.value.noteId > 0);
  const note = await app.call('memory_get', { items: [{ kind: 'note', id: accepted.value.noteId }], scope: 'global' });
  assert.equal(note.value.items[0].text, candidate.text);
  assert.match(note.value.items[0].source, /chunk:/);
  const queue = await app.call('memory_candidate', { action: 'list', status: 'all', scope: 'global' });
  const reviewed = queue.value.candidates.find(item => item.id === candidate.id);
  assert.equal(note.value.items[0].ts, reviewed.ts, 'accepted note must keep the candidate timestamp');
  assert.ok(note.value.items[0].importance >= 0.3, 'candidate confidence must map to importance');
  const search = await app.call('memory_search', { query: '候选队列先确认再入库', scope: 'global' });
  assert.ok(search.value.hits.some(hit => hit.kind === 'note' && hit.id === accepted.value.noteId), 'accepted note should not be shadowed by its source chunk');
});

test('candidate rejection leaves the transcript but keeps notes empty', async () => {
  const app = await boot();
  const result = await app.call('memory_ingest', {
    text: '以后不要把临时调试内容写进长期记忆。',
    role: 'user',
    scope: 'global',
  });
  const candidate = result.value.candidates[0];
  const rejected = await app.call('memory_candidate', {
    action: 'reject', id: candidate.id, reason: '临时内容', scope: 'global',
  });
  assert.equal(rejected.value.status, 'rejected');
  const queue = await app.call('memory_candidate', { action: 'list', scope: 'global' });
  assert.equal(queue.value.total, 0);
  const profile = await app.call('memory_profile', { scope: 'global' });
  assert.equal(profile.value.stats.notes, 0);
});

test('candidate visibility stays inside the selected project', async () => {
  const app = await boot();
  const alpha = 'proj:alpha#111111';
  const beta = 'proj:beta#222222';
  const result = await app.call('memory_ingest', {
    text: '项目约定：以后改端口必须同步 README。',
    role: 'user',
    scope: alpha,
  });
  assert.equal(result.value.candidates.length, 1);
  const foreign = await app.call('memory_candidate', { action: 'list', scope: beta });
  assert.equal(foreign.value.total, 0);
  const all = await app.call('memory_candidate', { action: 'list', scope: 'all' });
  assert.equal(all.value.total, 1);
  const accepted = await app.call('memory_candidate', {
    action: 'accept', id: result.value.candidates[0].id, scope: alpha,
  });
  assert.equal(accepted.value.status, 'accepted');
  const foreignAccept = await app.call('memory_candidate', {
    action: 'accept', id: result.value.candidates[0].id + 100, scope: beta,
  }).catch(error => ({ error }));
  assert.ok(foreignAccept.error || foreignAccept.value?.status !== 'accepted');
});

test('duplicate ingest is deduped and does not duplicate the queue', async () => {
  const app = await boot();
  const input = { text: '记住：同一轮转录不要重复入库。', role: 'user', scope: 'global' };
  const first = await app.call('memory_ingest', input);
  const second = await app.call('memory_ingest', input);
  assert.equal(second.value.deduped, true);
  assert.equal(second.value.candidates.length, 0);
  const queue = await app.call('memory_candidate', { action: 'list', scope: 'global' });
  assert.equal(queue.value.total, first.value.candidates.length);
});

test('POST /omni-memory/ingest is loopback + CSRF guarded', async () => {
  const app = await boot();
  const { res, state, json } = fakeRes();
  const body = {};
  const req = fakePost(body, '127.0.0.1', '/omni-memory/ingest?text=' + encodeURIComponent('记住：接口写入要带 CSRF') + '&scope=global');
  req.headers = { host: '127.0.0.1', 'x-omni-csrf': '1' };
  await app.route('/omni-memory/ingest').handler(req, res);
  assert.equal(state.statusCode, 200);
  assert.equal(json().ok, true);
  assert.equal(json().candidates.length, 1);
});

test('POST /omni-memory/ingest accepts a JSON body when the host has not consumed it', async () => {
  const app = await boot();
  const { res, state, json } = fakeRes();
  const req = fakePost({ text: '记住：JSON 请求体也要能写入。', role: 'user', scope: 'global' }, '127.0.0.1', '/omni-memory/ingest');
  req.headers = { host: '127.0.0.1', 'x-omni-csrf': '1' };
  await app.route('/omni-memory/ingest').handler(req, res);
  assert.equal(state.statusCode, 200);
  assert.equal(json().ok, true);
  assert.equal(json().candidates.length > 0, true);
});
