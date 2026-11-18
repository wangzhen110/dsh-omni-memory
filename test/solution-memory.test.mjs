import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { boot, fakeReq, fakeRes } from './helpers.mjs';

// Keep this file on the lexical route so ranking assertions isolate the new
// solution-status boost from vector/embedding variance.
process.env.OMNI_DISABLE_VECTOR = '1';

test('a note can carry a normalized problem fingerprint and real solution status', async () => {
  const app = await boot();
  const written = await app.call('memory_write', {
    kind: 'note', scope: 'global',
    text: 'EADDRINUSE on port 8000: stop the stale node process, then restart the service.',
    problemKey: '  EADDRINUSE:   port 8000 ',
    solutionStatus: 'verified',
    evidence: 'node service started and /health returned 200',
  });
  assert.equal(written.value.problemKey, 'eaddrinuse: port 8000');
  assert.equal(written.value.solutionStatus, 'verified');
  assert.equal(written.value.reuseCount, 0);

  const found = await app.call('memory_search', {
    problemKey: 'EADDRINUSE: Port 8000', scope: 'all',
  });
  assert.equal(found.value.hits.length, 1);
  assert.equal(found.value.hits[0].exactProblem, true);
  assert.equal(found.value.hits[0].solutionStatus, 'verified');
  assert.equal(found.value.hits[0].evidence, 'node service started and /health returned 200');
  assert.ok(found.value.hits[0].verifiedAt > 0, 'solution verification keeps its own timestamp');
});

test('verified solutions rank above failed attempts for the same query', async () => {
  const app = await boot();
  const common = 'SolutionRank timeout while calling the local gateway';
  await app.call('memory_write', {
    kind: 'note', scope: 'global', text: `${common}: unverified lead`,
  });
  await app.call('memory_write', {
    kind: 'note', scope: 'global', text: `${common}: dead end`,
    solutionStatus: 'failed', evidence: 'retry did not help',
  });
  const proven = await app.call('memory_write', {
    kind: 'note', scope: 'global', text: `${common}: proven fix`,
    solutionStatus: 'verified', evidence: 'gateway call returned 200',
  });
  const result = await app.call('memory_search', { query: 'SolutionRank', scope: 'all' });
  assert.equal(result.value.hits[0].id, proven.value.id);
  assert.equal(result.value.hits[0].solutionStatus, 'verified');
  const failed = result.value.hits.find(hit => hit.solutionStatus === 'failed');
  assert.ok(failed, 'failed attempts stay searchable');
});

test('status and kind filters narrow the result set without leaking other layers', async () => {
  const app = await boot();
  const verified = await app.call('memory_write', {
    kind: 'note', scope: 'global', text: 'StatusFilter 可用解法',
    problemKey: 'StatusFilter shared signature', solutionStatus: 'verified',
  });
  const failed = await app.call('memory_write', {
    kind: 'note', scope: 'global', text: 'StatusFilter 失败尝试',
    problemKey: 'StatusFilter shared signature', solutionStatus: 'failed',
  });
  await app.call('memory_write', {
    kind: 'fact', scope: 'global', text: 'StatusFilter 事实',
    subject: 'StatusFilter', relation: 'state', object: 'fact',
  });

  const onlyFailed = await app.call('memory_search', {
    problemKey: 'StatusFilter shared signature', scope: 'all', status: 'failed',
  });
  assert.deepEqual(onlyFailed.value.hits.map(hit => hit.id), [failed.value.id]);

  const onlyNotes = await app.call('memory_search', {
    query: 'StatusFilter', scope: 'all', kind: 'note',
  });
  assert.ok(onlyNotes.value.hits.every(hit => hit.kind === 'note'));
  assert.ok(onlyNotes.value.hits.some(hit => hit.id === verified.value.id));

  const kindFact = await app.call('memory_search', {
    problemKey: 'StatusFilter shared signature', scope: 'all', kind: 'fact',
  });
  assert.equal(kindFact.value.hits.length, 0, 'an exact note fingerprint must not leak into kind=fact');
});

test('solution report closes the loop: success verifies, later failure downgrades', async () => {
  const app = await boot();
  const written = await app.call('memory_write', {
    kind: 'note', scope: 'global', text: 'ReportLoop retry with a fresh token',
    problemKey: 'ReportLoop auth expired', solutionStatus: 'unverified',
  });
  const success = await app.call('memory_solution_report', {
    id: written.value.id, outcome: 'success', evidence: 'request returned 200',
  });
  assert.equal(success.value.solutionStatus, 'verified');
  assert.equal(success.value.reuseCount, 1);
  assert.ok(success.value.verifiedAt > 0);

  const failed = await app.call('memory_solution_report', {
    id: written.value.id, outcome: 'failed', evidence: 'the next run failed again',
  });
  assert.equal(failed.value.solutionStatus, 'failed');
  assert.equal(failed.value.reuseCount, 2);
  assert.equal(failed.value.verifiedAt, null);
});

test('solution report rejects unknown or inactive notes', async () => {
  const app = await boot();
  await assert.rejects(() => app.call('memory_solution_report', { id: 999, outcome: 'success' }));
  const written = await app.call('memory_write', { kind: 'note', scope: 'global', text: 'ReportGone 待删除' });
  await app.call('memory_forget', { kind: 'note', id: written.value.id });
  await assert.rejects(() => app.call('memory_solution_report', { id: written.value.id, outcome: 'success' }));
});

test('rewriting an existing note can attach experience metadata without a new row', async () => {
  const app = await boot();
  const first = await app.call('memory_write', { kind: 'note', scope: 'global', text: 'DedupeMeta same conclusion' });
  const second = await app.call('memory_write', {
    kind: 'note', scope: 'global', text: 'DedupeMeta same conclusion',
    problemKey: 'DedupeMeta signature', solutionStatus: 'verified', evidence: 'verified in a smoke test',
  });
  assert.equal(second.value.id, first.value.id);
  assert.equal(second.value.deduped, true);
  assert.equal(second.value.solutionStatus, 'verified');

  const found = await app.call('memory_search', { problemKey: 'DedupeMeta signature', scope: 'all' });
  assert.equal(found.value.hits.length, 1);
  assert.equal(found.value.hits[0].id, first.value.id);
  assert.equal(found.value.hits[0].solutionStatus, 'verified');
});

test('backup export and import preserve solution fields', async () => {
  const source = await boot();
  const written = await source.call('memory_write', {
    kind: 'note', scope: 'global', text: 'BackupSolution 可恢复的解法',
    problemKey: 'BackupSolution signature', solutionStatus: 'verified', evidence: 'restore smoke test',
  });
  const file = path.join(source.home, 'solution-backup.json');
  await source.call('memory_export', { path: file });
  const snapshot = JSON.parse(readFileSync(file, 'utf8'));
  const row = snapshot.notes.find(note => note.id === written.value.id);
  assert.equal(row.problem_key, 'backupsolution signature');
  assert.equal(row.solution_status, 'verified');
  assert.equal(row.solution_verified_at > 0, true);
  assert.equal(row.evidence, 'restore smoke test');

  const targetHome = mkdtempSync(path.join(tmpdir(), 'omni-solution-import-'));
  const target = await boot({ home: targetHome });
  await target.call('memory_import', { path: file, dryRun: false });
  const found = await target.call('memory_search', { problemKey: 'BackupSolution signature', scope: 'all' });
  assert.equal(found.value.hits.length, 1);
  assert.equal(found.value.hits[0].solutionStatus, 'verified');
  assert.equal(found.value.hits[0].evidence, 'restore smoke test');
});

test('problem metadata is note-only', async () => {
  const app = await boot();
  await assert.rejects(() => app.call('memory_write', {
    kind: 'fact', scope: 'global', text: 'bad', subject: 'x', relation: 'is', object: 'y',
    problemKey: 'not-a-note',
  }));
});

test('the list route exposes solution fields for the UI', async () => {
  const app = await boot();
  await app.call('memory_write', {
    kind: 'note', scope: 'global', text: 'ListSolution 可见的解法',
    problemKey: 'ListSolution signature', solutionStatus: 'verified',
  });
  const res = fakeRes();
  await app.route('/omni-memory/list').handler(fakeReq('/omni-memory/list?scope=global'), res.res);
  const body = res.json();
  assert.equal(body.stats.solutionsVerified, 1);
  assert.equal(body.notes[0].problem_key, 'listsolution signature');
  assert.equal(body.notes[0].solution_status, 'verified');
});

test('failed and expired attempts never enter the always-on profile', async () => {
  const app = await boot();
  await app.call('memory_write', {
    kind: 'note', scope: 'global', text: 'ProfileSafe proven approach', importance: 0.1,
    solutionStatus: 'verified',
  });
  await app.call('memory_write', {
    kind: 'note', scope: 'global', text: 'ProfileDead failed approach', importance: 1,
    solutionStatus: 'failed',
  });
  await app.call('memory_write', {
    kind: 'note', scope: 'global', text: 'ProfileExpired stale approach', importance: 1,
    solutionStatus: 'expired',
  });
  const profile = await app.call('memory_profile');
  assert.match(profile.value.text, /ProfileSafe/);
  assert.doesNotMatch(profile.value.text, /ProfileDead|ProfileExpired/);
});
