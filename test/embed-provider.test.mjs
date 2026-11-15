import test from 'node:test';
import assert from 'node:assert/strict';
import { backendConfig, normalize, embedRemote, HASHED_DIM } from '../lib/embed-provider.mjs';

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
  const vectors = await embedRemote(['a', 'b'], { url: 'http://x/embeddings', model: 'm', key: 'k', timeoutMs: 1000 }, fakeFetch);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.input, ['a', 'b']);
  assert.equal(calls[0].headers.authorization, 'Bearer k');
  assert.equal(vectors.length, 2);
  assert.ok(Math.abs(vectors[0][0] - Math.SQRT1_2) < 1e-6);
  assert.ok(Math.abs(vectors[1][1] - 1) < 1e-6);
});

test('embedRemote rejects a non-ok response', async () => {
  const fakeFetch = async () => ({ ok: false, status: 500, async json() { return {}; } });
  await assert.rejects(
    () => embedRemote(['a'], { url: 'http://x', model: 'm', key: '', timeoutMs: 1000 }, fakeFetch),
    /embeddings responded 500/,
  );
});

test('embedRemote rejects a shape mismatch instead of returning garbage', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, async json() { return { data: [] }; } });
  await assert.rejects(
    () => embedRemote(['a'], { url: 'http://x', model: 'm', key: '', timeoutMs: 1000 }, fakeFetch),
    /shape mismatch/,
  );
});
