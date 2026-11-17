import test from 'node:test';
import assert from 'node:assert/strict';

// Force a tiny recent-window: the test proves exact matches outside the window
// are still reachable through the FTS sample, and that scope filtering happens
// even for rows the window never touched.
process.env.OMNI_SEARCH_WINDOW = '50';
const { boot } = await import('./helpers.mjs');

const PROJECT_A = 'proj:window-a#aaa111';
const PROJECT_B = 'proj:window-b#bbb222';

async function fill(app, prefix, count, scope = 'global') {
  for (let i = 0; i < count; i += 1) {
    await app.call('memory_write', { kind: 'note', scope, text: `${prefix} filler ${i}`, importance: 0.1 });
  }
}

test('an exact match older than the recent window is still retrievable', async () => {
  const app = await boot();
  await app.call('memory_write', { kind: 'note', scope: 'global', text: 'Archaeopteryx 是窗口外的旧结论', importance: 0.9 });
  await fill(app, 'windowbias', 120);

  const hits = (await app.call('memory_search', { query: 'Archaeopteryx', scope: 'global', limit: 8 })).value.hits;
  assert.ok(hits.some(hit => hit.kind === 'note' && hit.text.includes('Archaeopteryx')), 'old exact match lost');
});

test('project scope still filters rows that the window never scanned', async () => {
  const app = await boot();
  await app.call('memory_write', { kind: 'note', scope: PROJECT_A, text: 'WindowA 项目旧结论 velociraptor' });
  await fill(app, 'recentb', 120, PROJECT_B);

  const projectHits = (await app.call('memory_search', { query: 'velociraptor', scope: PROJECT_A, limit: 8 })).value.hits;
  assert.ok(projectHits.some(hit => hit.kind === 'note' && hit.text.includes('WindowA')));
  assert.equal(
    projectHits.some(hit => String(hit.text).includes('recentb')),
    false,
    'another project must not leak when the window only saw its rows',
  );
});
