import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { boot } from './helpers.mjs';

/**
 * Remote embedding integration: a real HTTP server on loopback, OpenAI-compatible
 * response shape, real fetch/timeout/retry paths. The vectors are deterministic
 * so the assertions are about the plugin's lifecycle, not a model's quality.
 */

function startProvider({ dim = 16, down = false } = {}) {
  if (down) {
    const server = http.createServer();
    return new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve({ url: `http://127.0.0.1:${port}/v1/embeddings`, close: () => {} }));
      });
    });
  }
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      let texts = [];
      try { texts = JSON.parse(raw).input ?? []; } catch { /* empty */ }
      const embedding = Array.from({ length: dim }, (_, i) => (i === 0 ? 1 : 0.01));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        object: 'list',
        model: 'mock-embed',
        data: texts.map((text, index) => ({ object: 'embedding', index, embedding })),
      }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/v1/embeddings`, close: () => new Promise(done => server.close(done)) });
    });
  });
}

const dimOf = home => {
  const db = new DatabaseSync(path.join(home, 'memory', 'omni.db'));
  const row = db.prepare('SELECT dim, COUNT(*) AS n FROM vectors GROUP BY dim').get();
  const meta = db.prepare("SELECT value FROM meta WHERE key = 'remote_dim'").get()?.value;
  db.close();
  return { dim: row?.dim ?? null, count: row?.n ?? 0, meta };
};

test('remote provider: probe persists the dimension across a restart', async () => {
  const provider = await startProvider();
  process.env.OMNI_EMBED_URL = provider.url;
  process.env.OMNI_EMBED_MODEL = 'mock-embed';
  try {
    const first = await boot();
    const written = await first.call('memory_write', { kind: 'note', scope: 'global', text: '远程向量 生命周期 验证' });
    assert.ok(written.value.id);
    // The probe happens on the first vector search, then its dimension is persisted.
    await first.call('memory_search', { query: '远程向量', scope: 'all' });

    // A fresh module instance with the same home must not re-probe from scratch.
    const second = await boot({ home: first.home });
    await second.call('memory_search', { query: '远程向量', scope: 'all' });
    const db = new DatabaseSync(path.join(first.home, 'memory', 'omni.db'));
    const meta = db.prepare("SELECT value FROM meta WHERE key = 'remote_dim'").get()?.value;
    const signature = db.prepare("SELECT value FROM meta WHERE key = 'remote_signature'").get()?.value;
    db.close();
    assert.equal(meta, '16');
    assert.ok(signature && signature.length >= 8, 'signature is persisted too');
  } finally {
    delete process.env.OMNI_EMBED_URL;
    delete process.env.OMNI_EMBED_MODEL;
    await provider.close();
  }
});

test('remote provider: writes queue vectors and search flushes them', async () => {
  const provider = await startProvider();
  process.env.OMNI_EMBED_URL = provider.url;
  process.env.OMNI_EMBED_MODEL = 'mock-embed';
  try {
    const app = await boot();
    await app.call('memory_write', { kind: 'note', scope: 'global', text: '远程向量 会 入队' });

    const hits = await app.call('memory_search', { query: '完全无关的查询词', scope: 'all' });
    assert.equal(hits.value.hits.length > 0, true, 'vector route should surface the note');
    assert.ok(hits.value.hits.some(hit => Number.isFinite(hit.vectorScore)), 'a vector score is present');

    const vectors = dimOf(app.home);
    assert.equal(vectors.dim, 16);
    assert.ok(vectors.count >= 1);
  } finally {
    delete process.env.OMNI_EMBED_URL;
    delete process.env.OMNI_EMBED_MODEL;
    await provider.close();
  }
});

test('remote provider: an unreachable endpoint degrades to lexical without hanging', async () => {
  const provider = await startProvider({ down: true });
  process.env.OMNI_EMBED_URL = provider.url;
  process.env.OMNI_EMBED_MODEL = 'mock-embed';
  try {
    const app = await boot();
    await app.call('memory_write', { kind: 'note', scope: 'global', text: '端点不可用时的词面答案' });

    const started = process.hrtime.bigint();
    const hits = await app.call('memory_search', { query: '词面答案', scope: 'all' });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(hits.value.hits.length > 0, 'lexical route still answers');
    assert.ok(elapsedMs < 3000, `search must not wait on the endpoint (${elapsedMs.toFixed(0)}ms)`);
  } finally {
    delete process.env.OMNI_EMBED_URL;
    delete process.env.OMNI_EMBED_MODEL;
    await provider.close();
  }
});
