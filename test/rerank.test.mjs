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
