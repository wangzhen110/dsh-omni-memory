import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, fakeReq, fakeRes } from './helpers.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function seed(app) {
  await app.call('memory_write', {
    kind: 'note', text: '部署方式最终选择裸机进程方案', importance: 0.9,
  });
}

test('auto recall appends the closest memories to the prompt section', async () => {
  const previous = process.env.OMNI_AUTO_RECALL;
  delete process.env.OMNI_AUTO_RECALL; // switch is on unless set to '0'
  try {
    const app = await boot();
    await seed(app);
    app.fireInbox('上次那个部署方案是什么来着');
    await wait(150); // precompute is intentionally asynchronous
    const text = app.section().text({ scope: { id: 'agent-test' } });
    assert.match(text, /Recalled for this request/);
    assert.match(text, /裸机进程方案/);
  } finally {
    if (previous === undefined) delete process.env.OMNI_AUTO_RECALL;
    else process.env.OMNI_AUTO_RECALL = previous;
  }
});

test('OMNI_AUTO_RECALL=0 keeps recall out of the prompt', async () => {
  const previous = process.env.OMNI_AUTO_RECALL;
  process.env.OMNI_AUTO_RECALL = '0';
  try {
    const app = await boot();
    await seed(app);
    app.fireInbox('上次那个部署方案是什么来着');
    await wait(150);
    const text = app.section().text({ scope: { id: 'agent-test' } });
    assert.equal(text.includes('Recalled for this request'), false);
  } finally {
    if (previous === undefined) delete process.env.OMNI_AUTO_RECALL;
    else process.env.OMNI_AUTO_RECALL = previous;
  }
});

test('the status route reports injection statistics for the footer', async () => {
  const previous = process.env.OMNI_AUTO_RECALL;
  delete process.env.OMNI_AUTO_RECALL;
  try {
    const app = await boot();
    await seed(app);
    app.fireInbox('部署方案');
    await wait(150);
    app.section().text({ scope: { id: 'agent-test' } });

    const { res, state, json } = fakeRes();
    await app.route('/omni-memory/status').handler(fakeReq('/omni-memory/status'), res);
    assert.equal(state.statusCode, 200);
    const body = json();
    assert.equal(body.ok, true);
    assert.equal(body.autoRecall, true);
    assert.ok(body.lastInjection.chars > 0);
    assert.ok(body.lastInjection.recall >= 1);
    assert.ok(body.stats.notes >= 1);
  } finally {
    if (previous === undefined) delete process.env.OMNI_AUTO_RECALL;
    else process.env.OMNI_AUTO_RECALL = previous;
  }
});

test('the status route is loopback only', async () => {
  const app = await boot();
  const { res, state } = fakeRes();
  await app.route('/omni-memory/status').handler(fakeReq('/omni-memory/status', '8.8.8.8'), res);
  assert.equal(state.statusCode, 403);
});

test('an empty recall race degrades to profile-only injection', async () => {
  const app = await boot();
  await seed(app);
  // No inbox event fired: the provider must still return the profile.
  const text = app.section().text({ scope: { id: 'agent-never-seen' } });
  assert.match(text, /裸机进程方案/);
  assert.equal(text.includes('Recalled for this request'), false);
});
