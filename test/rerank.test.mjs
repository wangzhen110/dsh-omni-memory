import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { boot } from './helpers.mjs';
import { rerankConfig, rerankRemote } from '../lib/rerank-provider.mjs';

test('rerank is disabled without a configured endpoint', () => {
  const old = { ...process.env };
  delete process.env.OMNI_RERANK_URL;
  delete process.env.OMNI_RERANK_PROVIDER;
  const config = rerankConfig();
  assert.equal(config.kind, 'none');
  process.env = old;
});

test('rerankRemote sends documents and maps provider scores by index', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body), headers: options.headers });
    return {
      ok: true,
      async json() {
        return { results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] };
      },
    };
  };
  const scores = await rerankRemote('query', ['first', 'second'], {
    kind: 'remote', url: 'http://example.test/rerank', model: 'test-model', key: 'secret', timeoutMs: 500,
  }, fetchImpl);
  assert.deepEqual(scores, [0.1, 0.9]);
  assert.equal(requests[0].body.query, 'query');
  assert.deepEqual(requests[0].body.documents, ['first', 'second']);
  assert.equal(requests[0].headers.authorization, 'Bearer secret');
});

test('negative rerank logits are normalized instead of silently skipped', async () => {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const documents = Array.isArray(body.documents) ? body.documents : [];
      const results = documents.map((text, index) => ({
        index,
        relevance_score: String(text).includes('答案乙') ? -0.1 : -0.9,
      }));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ results }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const oldUrl = process.env.OMNI_RERANK_URL;
  process.env.OMNI_RERANK_URL = `http://127.0.0.1:${server.address().port}/rerank`;
  const app = await boot();
  try {
    await app.call('memory_write', { kind: 'note', text: '负分查询 答案甲 通用占位', scope: 'proj:alpha' });
    await app.call('memory_write', { kind: 'note', text: '负分查询 答案乙 精确占位', scope: 'proj:alpha' });
    const result = await app.call('memory_search', { query: '负分查询 答案甲', scope: 'proj:alpha', limit: 5, rerank: true });
    assert.equal(result.value.hits[0].text.includes('答案乙'), true);
  } finally {
    if (oldUrl === undefined) delete process.env.OMNI_RERANK_URL; else process.env.OMNI_RERANK_URL = oldUrl;
    await new Promise(resolve => server.close(resolve));
  }
});

test('an exact problemKey hit is not buried by a reranker preference', async () => {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const documents = Array.isArray(body.documents) ? body.documents : [];
      const results = documents.map((text, index) => ({
        index,
        relevance_score: String(text).includes('普通结论') ? 0.99 : 0.01,
      }));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ results }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const oldUrl = process.env.OMNI_RERANK_URL;
  process.env.OMNI_RERANK_URL = `http://127.0.0.1:${server.address().port}/rerank`;
  const app = await boot();
  try {
    const exact = await app.call('memory_write', {
      kind: 'note', text: '部署失败 精确结论 检查端口', scope: 'proj:alpha', problemKey: 'deploy.fail',
    });
    await app.call('memory_write', { kind: 'note', text: '部署失败 普通结论 无关内容', scope: 'proj:alpha' });
    const result = await app.call('memory_search', {
      query: '部署失败 检查端口', problemKey: 'deploy.fail', scope: 'proj:alpha', limit: 5, rerank: true,
    });
    assert.equal(result.value.hits[0].id, exact.value.id);
  } finally {
    if (oldUrl === undefined) delete process.env.OMNI_RERANK_URL; else process.env.OMNI_RERANK_URL = oldUrl;
    await new Promise(resolve => server.close(resolve));
  }
});

test('memory_search applies the optional reranker before finalizing hits', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received.push(body);
      const documents = Array.isArray(body.documents) ? body.documents : [];
      const results = documents.map((text, index) => ({
        index,
        relevance_score: String(text).includes('答案乙') ? 0.95 : 0.05,
      }));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ results }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const oldUrl = process.env.OMNI_RERANK_URL;
  const oldModel = process.env.OMNI_RERANK_MODEL;
  process.env.OMNI_RERANK_URL = `http://127.0.0.1:${port}/rerank`;
  process.env.OMNI_RERANK_MODEL = 'stub-reranker';
  const app = await boot();
  try {
    await app.call('memory_write', { kind: 'note', text: '问题 答案甲 通用占位', scope: 'proj:alpha' });
    await app.call('memory_write', { kind: 'note', text: '问题 答案乙 精确占位', scope: 'proj:alpha' });
    const result = await app.call('memory_search', { query: '问题 答案甲', scope: 'proj:alpha', limit: 5, rerank: true });
    assert.equal(result.value.hits[0].text.includes('答案乙'), true);
    assert.ok(received.length >= 1);
    assert.equal(received[0].model, 'stub-reranker');
  } finally {
    if (oldUrl === undefined) delete process.env.OMNI_RERANK_URL; else process.env.OMNI_RERANK_URL = oldUrl;
    if (oldModel === undefined) delete process.env.OMNI_RERANK_MODEL; else process.env.OMNI_RERANK_MODEL = oldModel;
    await new Promise(resolve => server.close(resolve));
  }
});

// --- failure matrix: previously verified only by hand ---

const RERANK_SCOPE = 'proj:rerank-failure-matrix';
const RERANK_QUERY = '失败矩阵';

function startRerankServer(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/rerank`,
        close: () => new Promise(done => server.close(done)),
      });
    });
  });
}

const drainBody = req => new Promise(resolve => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
});

// Two notes that both match the query and are otherwise indistinguishable, so
// a stable lexical tie keeps 答案甲 first unless the reranker says otherwise.
async function seedTwoNotes() {
  const app = await boot();
  await app.call('memory_write', { kind: 'note', text: '失败矩阵 答案甲 第一笔记', scope: RERANK_SCOPE });
  await app.call('memory_write', { kind: 'note', text: '失败矩阵 答案乙 第二笔记', scope: RERANK_SCOPE });
  return app;
}

const searchReranked = app => app.call('memory_search', {
  query: RERANK_QUERY, scope: RERANK_SCOPE, limit: 5, rerank: true,
});
const searchPlain = app => app.call('memory_search', {
  query: RERANK_QUERY, scope: RERANK_SCOPE, limit: 5, rerank: false,
});
const hitTexts = result => result.value.hits.map(hit => hit.text);

test('rerankRemote rejects when fetchImpl throws or the timeout aborts the signal', async () => {
  const config = { kind: 'remote', url: 'http://x/rerank', model: 'm', key: '', timeoutMs: 20 };
  await assert.rejects(
    () => rerankRemote('q', ['a', 'b'], config, async () => { throw new Error('socket hang up'); }),
    /socket hang up/,
  );

  let seenSignal;
  const abortingFetch = (url, init) => {
    seenSignal = init.signal;
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  };
  await assert.rejects(
    () => rerankRemote('q', ['a', 'b'], config, abortingFetch),
    error => error?.name === 'AbortError',
  );
  assert.equal(seenSignal.aborted, true, 'timeout must abort the signal handed to fetchImpl');
});

test('memory_search falls back to the fused order when rerank times out (AbortError)', async () => {
  let seenRequest = false;
  const server = await startRerankServer((req, res) => {
    seenRequest = true;
    let timer;
    res.on('close', () => clearTimeout(timer));
    drainBody(req).then(() => {
      // Longer than the 500ms floor enforced by rerankConfig(), so the global
      // fetch used inside maybeRerank aborts with an AbortError.
      timer = setTimeout(() => {
        if (!res.destroyed) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ results: [] }));
        }
      }, 1200);
    });
  });
  const saved = { ...process.env };
  process.env.OMNI_RERANK_URL = server.url;
  process.env.OMNI_RERANK_TIMEOUT_MS = '500';
  try {
    const app = await seedTwoNotes();
    const baseline = hitTexts(await searchPlain(app));
    assert.equal(baseline.length, 2);
    const fallback = hitTexts(await searchReranked(app));
    assert.equal(seenRequest, true, 'the rerank endpoint must actually be called');
    assert.deepEqual(fallback, baseline, 'timeout must fall back to the original order, not throw');
  } finally {
    process.env = saved;
    await server.close();
  }
});

test('memory_search falls back to the fused order when rerank returns 500', async () => {
  let calls = 0;
  const server = await startRerankServer(async (req, res) => {
    await drainBody(req);
    calls += 1;
    res.statusCode = 500;
    res.end('{"error":"upstream down"}');
  });
  const saved = { ...process.env };
  process.env.OMNI_RERANK_URL = server.url;
  try {
    const app = await seedTwoNotes();
    const baseline = hitTexts(await searchPlain(app));
    const fallback = hitTexts(await searchReranked(app));
    assert.equal(calls, 1, 'non-2xx must be attempted once by the reranker');
    assert.deepEqual(fallback, baseline, 'a 500 must not crash search or reorder hits');
  } finally {
    process.env = saved;
    await server.close();
  }
});

test('memory_search falls back to the fused order on malformed JSON or missing results', async () => {
  let mode = 'malformed';
  let calls = 0;
  const server = await startRerankServer(async (req, res) => {
    await drainBody(req);
    calls += 1;
    res.setHeader('content-type', 'application/json');
    if (mode === 'malformed') res.end('{ this is not json');
    else res.end(JSON.stringify({ data: [] })); // no results / data array at all
  });
  const saved = { ...process.env };
  process.env.OMNI_RERANK_URL = server.url;
  try {
    const app = await seedTwoNotes();
    const baseline = hitTexts(await searchPlain(app));

    const malformed = hitTexts(await searchReranked(app));
    assert.deepEqual(malformed, baseline, 'malformed JSON must fall back to the original order');

    mode = 'missing';
    const missing = hitTexts(await searchReranked(app));
    assert.deepEqual(missing, baseline, 'missing results must fall back to the original order');
    assert.equal(calls, 2, 'both bad payloads must still reach the rerank endpoint');
  } finally {
    process.env = saved;
    await server.close();
  }
});

test('all-zero rerank scores carry no ranking signal and keep the original order', async () => {
  let mode = 'normal'; // 'normal' reorders, 'zero' must not
  let favored = '答案乙';
  const server = await startRerankServer(async (req, res) => {
    const raw = await drainBody(req);
    const { documents = [] } = JSON.parse(raw);
    const results = documents.map((text, index) => ({
      index,
      relevance_score: mode === 'zero'
        ? 0
        : (String(text).includes(favored) ? 0.99 : 0.01),
    }));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ results }));
  });
  const saved = { ...process.env };
  process.env.OMNI_RERANK_URL = server.url;
  try {
    const app = await seedTwoNotes();
    const baseline = hitTexts(await searchPlain(app));
    assert.equal(baseline.length, 2);
    // Aim the reranker at the note that is NOT first in the original order, so
    // a successful reorder is observable and the zero case is meaningful.
    favored = baseline[0].includes('答案甲') ? '答案乙' : '答案甲';

    const withSignal = hitTexts(await searchReranked(app));
    assert.equal(withSignal[0].includes(favored), true, 'non-zero scores must reorder relative to baseline');

    mode = 'zero';
    const allZero = hitTexts(await searchReranked(app));
    assert.deepEqual(allZero, baseline, 'all-zero scores must preserve the original fused order');
  } finally {
    process.env = saved;
    await server.close();
  }
});
