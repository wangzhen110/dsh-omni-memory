import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { backendConfig, normalize, embedRemote, HASHED_DIM } from '../lib/embed-provider.mjs';

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/v1/embeddings`, close: () => new Promise(done => server.close(done)) });
    });
  });
}

const readBody = req => new Promise(resolve => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => resolve(raw));
});

test('backend selection defaults to the hashed model without env vars', () => {
  const config = backendConfig({});
  assert.equal(config.kind, 'hashed');
  assert.equal(config.dim, HASHED_DIM);
});

test('backend selection switches to remote when a URL is configured', () => {
  const config = backendConfig({ OMNI_EMBED_URL: 'http://127.0.0.1:9/v1/embeddings', OMNI_EMBED_MODEL: 'm', OMNI_EMBED_KEY: 'k' });
  assert.equal(config.kind, 'remote');
  assert.equal(config.url, 'http://127.0.0.1:9/v1/embeddings');
  assert.equal(config.model, 'm');
  assert.equal(config.key, 'k');
  assert.equal(config.batch, 64);
  assert.equal(config.retries, 2);
});

test('provider presets fill url and model when only the provider is set', () => {
  const config = backendConfig({ OMNI_EMBED_PROVIDER: 'openai' });
  assert.equal(config.kind, 'remote');
  assert.match(config.url, /api\.openai\.com/);
  assert.equal(config.model, 'text-embedding-3-small');
});

test('normalize returns a unit vector and tolerates zeros', () => {
  const unit = normalize(Float32Array.from([3, 4]));
  assert.ok(Math.abs(unit[0] - 0.6) < 1e-6);
  assert.ok(Math.abs(unit[1] - 0.8) < 1e-6);
  const zero = normalize(Float32Array.from([0, 0]));
  assert.deepEqual([...zero], [0, 0]);
});

test('embedRemote normalises vectors and preserves order', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return {
      ok: true,
      status: 200,
      async json() {
        return { data: [{ embedding: [1, 1] }, { embedding: [0, 2] }] };
      },
    };
  };
  const vectors = await embedRemote(['a', 'b'], { url: 'http://x/embeddings', model: 'm', key: 'k', timeoutMs: 1000, batch: 64, retries: 0 }, fakeFetch);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.input, ['a', 'b']);
  assert.equal(calls[0].headers.authorization, 'Bearer k');
  assert.equal(vectors.length, 2);
  assert.ok(Math.abs(vectors[0][0] - Math.SQRT1_2) < 1e-6);
  assert.ok(Math.abs(vectors[1][1] - 1) < 1e-6);
});

test('embedRemote rejects a permanent non-ok response without retrying', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return { ok: false, status: 400, async json() { return {}; } };
  };
  await assert.rejects(
    () => embedRemote(['a'], { url: 'http://x', model: 'm', key: '', timeoutMs: 1000, batch: 64, retries: 2 }, fakeFetch),
    /embeddings responded 400/,
  );
  assert.equal(calls, 1, '4xx other than 429 must not be retried');
});

test('embedRemote rejects a shape mismatch instead of returning garbage', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, async json() { return { data: [] }; } });
  await assert.rejects(
    () => embedRemote(['a'], { url: 'http://x', model: 'm', key: '', timeoutMs: 1000, batch: 64, retries: 0 }, fakeFetch),
    /shape mismatch/,
  );
});

test('a 429 is retried with backoff and the batch eventually succeeds', async () => {
  let calls = 0;
  const provider = await startServer(async (req, res) => {
    await readBody(req);
    calls += 1;
    if (calls <= 2) {
      res.statusCode = 429;
      res.end('{"error":"rate limit"}');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }));
  });
  try {
    const vectors = await embedRemote(['hello'], {
      kind: 'remote', url: provider.url, model: 'm', timeoutMs: 5000, batch: 64, retries: 2,
    });
    assert.equal(calls, 3);
    assert.equal(vectors.length, 1);
    assert.equal(vectors[0].length, 3);
  } finally {
    await provider.close();
  }
});

test('inputs are split into provider-sized batches', async () => {
  const sizes = [];
  const provider = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    sizes.push(body.input.length);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: body.input.map(() => ({ embedding: [1, 0] })) }));
  });
  try {
    const texts = Array.from({ length: 130 }, (_, i) => `text ${i}`);
    const vectors = await embedRemote(texts, {
      kind: 'remote', url: provider.url, model: 'm', timeoutMs: 5000, batch: 64, retries: 0,
    });
    assert.deepEqual(sizes, [64, 64, 2]);
    assert.equal(vectors.length, 130);
  } finally {
    await provider.close();
  }
});
