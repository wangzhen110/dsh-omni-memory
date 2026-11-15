import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Distinct names with no shared character bigrams, so a lexical or vector hit on
// one name cannot accidentally match another (which would mask the graph route).
const A = '阿尔法';
const B = '贝塔';
const C = '伽马';
const D = '德尔塔';
const E = '厄普西';

async function seedChain(app) {
  await app.call('memory_write', { kind: 'fact', subject: A, relation: '指向', object: B, text: `${A} 指向 ${B}` });
  await app.call('memory_write', { kind: 'fact', subject: B, relation: '导致', object: C, text: `${B} 导致 ${C}` });
  await app.call('memory_write', { kind: 'fact', subject: C, relation: '影响', object: D, text: `${C} 影响 ${D}` });
  await app.call('memory_write', { kind: 'fact', subject: D, relation: '终止', object: E, text: `${D} 终止 ${E}` });
}

test('FR-18 a neighbouring link is recalled through the graph route', async () => {
  const app = await boot();
  await seedChain(app);
  const hit = await app.call('memory_search', { query: A, limit: 20 });
  const texts = hit.value.hits.map(item => item.text);
  assert.ok(texts.some(text => text.includes(`${B} 导致 ${C}`)), 'the first link out of the seed must be recalled');
  const graphHit = hit.value.hits.find(item => item.graphScore > 0);
  assert.ok(graphHit, 'at least one hit must come from the graph route');
});

test('FR-18 the graph route stops at the configured hop limit', async () => {
  const app = await boot();
  await seedChain(app);
  const hit = await app.call('memory_search', { query: A, limit: 20 });
  const texts = hit.value.hits.map(item => item.text);
  assert.equal(texts.some(text => text.includes(`${D} 终止 ${E}`)), false, 'the far end of the chain must not be returned');
});

test('FR-18 OMNI_DISABLE_GRAPH removes the association route', async () => {
  const app = await boot();
  await seedChain(app);
  const previous = process.env.OMNI_DISABLE_GRAPH;
  process.env.OMNI_DISABLE_GRAPH = '1';
  try {
    const hit = await app.call('memory_search', { query: A, limit: 20 });
    const texts = hit.value.hits.map(item => item.text);
    assert.equal(texts.some(text => text.includes(`${B} 导致 ${C}`)), false);
    assert.equal(hit.value.hits.some(item => item.graphScore > 0), false);
  } finally {
    if (previous === undefined) delete process.env.OMNI_DISABLE_GRAPH;
    else process.env.OMNI_DISABLE_GRAPH = previous;
  }
});

test('FR-18 a scoped link is not leaked through the graph route', async () => {
  const app = await boot();
  await app.call('memory_write', { kind: 'fact', subject: A, relation: '指向', object: B, text: `${A} 指向 ${B}`, scope: 'proj:a' });
  await app.call('memory_write', { kind: 'fact', subject: B, relation: '导致', object: C, text: `${B} 导致 ${C}`, scope: 'proj:a' });
  const other = await app.call('memory_search', { query: A, scope: 'proj:b', limit: 20 });
  assert.equal(other.value.hits.length, 0);
});
