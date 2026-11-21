import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { boot } from './helpers.mjs';

function dbOf(app) {
  const db = new DatabaseSync(path.join(app.home, 'memory', 'omni.db'));
  db.exec('PRAGMA busy_timeout = 3000');
  return db;
}

test('schema v12 exposes recall-quality counters on notes and facts', async () => {
  const app = await boot();
  await app.call('memory_write', { kind: 'note', text: 'QualitySchema note' });
  const db = dbOf(app);
  for (const table of ['notes', 'facts']) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
    for (const column of ['recall_count', 'last_recall_at', 'useful_count', 'misleading_count']) {
      assert.ok(columns.includes(column), `${table}.${column} missing`);
    }
  }
  db.close();
});

test('memory_feedback records useful and misleading signals', async () => {
  const app = await boot();
  const written = await app.call('memory_write', { kind: 'note', text: 'QualityFeedback note' });
  const useful = await app.call('memory_feedback', { kind: 'note', id: written.value.id, rating: 'useful' });
  assert.equal(useful.value.usefulCount, 1);
  assert.equal(useful.value.misleadingCount, 0);
  assert.equal(useful.value.feedbackCount, 1);
  assert.ok(useful.value.lastFeedbackAt > 0);
  const misleading = await app.call('memory_feedback', { kind: 'note', id: written.value.id, rating: 'misleading' });
  assert.equal(misleading.value.usefulCount, 1);
  assert.equal(misleading.value.misleadingCount, 1);
  assert.equal(misleading.value.quality, 0.5);
});

test('feedback changes recall order without deleting either note', async () => {
  const app = await boot();
  const good = await app.call('memory_write', { kind: 'note', text: 'QualityRank 部署方案 A', importance: 0.3 });
  const bad = await app.call('memory_write', { kind: 'note', text: 'QualityRank 部署方案 B', importance: 0.3 });
  for (let i = 0; i < 3; i += 1) await app.call('memory_feedback', { kind: 'note', id: good.value.id, rating: 'useful' });
  for (let i = 0; i < 3; i += 1) await app.call('memory_feedback', { kind: 'note', id: bad.value.id, rating: 'misleading' });
  const hits = (await app.call('memory_search', { query: 'QualityRank', scope: 'global', limit: 5 })).value.hits;
  const ids = hits.filter(hit => hit.kind === 'note').map(hit => hit.id);
  assert.ok(ids.includes(good.value.id) && ids.includes(bad.value.id), 'both notes should remain visible');
  assert.ok(ids.indexOf(good.value.id) < ids.indexOf(bad.value.id), 'useful note should rank above misleading note');
});

test('memory_get expands a compact hit and reports missing ids', async () => {
  const app = await boot();
  const written = await app.call('memory_write', { kind: 'note', text: 'QualityExpand full text ' + 'x'.repeat(40) });
  const got = await app.call('memory_get', { items: [{ kind: 'note', id: written.value.id }] });
  assert.equal(got.value.items.length, 1);
  assert.equal(got.value.items[0].id, written.value.id);
  assert.match(got.value.items[0].text, /QualityExpand full text/);
  const missing = await app.call('memory_get', { items: [{ kind: 'note', id: 999999 }] });
  assert.equal(missing.value.items.length, 0);
  assert.equal(missing.value.missing.length, 1);
});

test('memory_amend creates a superseding revision and hides the old row', async () => {
  const app = await boot();
  const old = await app.call('memory_write', { kind: 'note', text: 'QualityAmend old wording' });
  const amended = await app.call('memory_amend', { id: old.value.id, text: 'QualityAmend corrected wording', reason: 'test revision' });
  assert.equal(amended.value.revision, 2);
  assert.equal(amended.value.superseded, old.value.id);

  const hits = (await app.call('memory_search', { query: 'QualityAmend', scope: 'global', limit: 10 })).value.hits;
  const ids = hits.filter(hit => hit.kind === 'note').map(hit => hit.id);
  assert.ok(ids.includes(amended.value.id), 'amended revision should be searchable');
  assert.ok(!ids.includes(old.value.id), 'superseded revision should be hidden');

  const oldGet = await app.call('memory_get', { items: [{ kind: 'note', id: old.value.id }] });
  assert.equal(oldGet.value.items.length, 0);
});

test('memory_amend preserves contested, verification, source and feedback counters', async () => {
  const app = await boot();
  const old = await app.call('memory_write', {
    kind: 'note',
    text: 'QualityAmendPreserve old wording',
    source: 'ORIGINAL-SOURCE',
  });
  const db = dbOf(app);
  const verifiedAt = 1700000000000;
  const feedbackAt = 1700000000001;
  db.prepare(`
    UPDATE notes SET contested = 1, verification = 'verified', verified_at = ?,
      evidence = 'original evidence', recall_count = 9, last_recall_at = ?,
      useful_count = 7, misleading_count = 2
    WHERE id = ?
  `).run(verifiedAt, feedbackAt, old.value.id);
  db.close();

  const amended = await app.call('memory_amend', {
    id: old.value.id,
    text: 'QualityAmendPreserve corrected wording',
    reason: 'fix wording',
  });
  const db2 = dbOf(app);
  const row = db2.prepare('SELECT * FROM notes WHERE id = ?').get(amended.value.id);
  const previous = db2.prepare('SELECT * FROM notes WHERE id = ?').get(old.value.id);
  db2.close();

  assert.equal(row.contested, 1);
  assert.equal(row.verification, 'verified');
  assert.equal(row.verified_at, verifiedAt);
  assert.equal(row.recall_count, 9);
  assert.equal(row.last_recall_at, feedbackAt);
  assert.equal(row.useful_count, 7);
  assert.equal(row.misleading_count, 2);
  assert.equal(row.source, 'ORIGINAL-SOURCE');
  assert.match(row.evidence, /original evidence/);
  assert.match(row.evidence, /\[amend\] fix wording/);
  assert.equal(previous.superseded_by, amended.value.id);
});

test('feedback and amend reject another project by default', async () => {
  const app = await boot();
  const foreign = await app.call('memory_write', {
    kind: 'note',
    text: 'QualityScope foreign project note',
    scope: 'proj:alpha',
  });
  await assert.rejects(
    () => app.call('memory_feedback', { kind: 'note', id: foreign.value.id, rating: 'useful' }),
    /outside the current project/,
  );
  await assert.rejects(
    () => app.call('memory_amend', { id: foreign.value.id, text: 'QualityScope corrected note' }),
    /outside the current project/,
  );

  const explicitFeedback = await app.call('memory_feedback', {
    kind: 'note', id: foreign.value.id, rating: 'useful', scope: 'all',
  });
  assert.equal(explicitFeedback.value.feedbackCount, 1);
  const explicitAmend = await app.call('memory_amend', {
    id: foreign.value.id, text: 'QualityScope corrected note', scope: 'all',
  });
  assert.equal(explicitAmend.value.revision, 2);
});
