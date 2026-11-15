import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { boot } from './helpers.mjs';

/**
 * A mock OpenAI-compatible embeddings endpoint. It maps text to a concept
 * vector by intent, which lets the test prove that a query sharing NO
 * characters with the stored note can still recall it — the exact capability
 * the hashed backend cannot provide (FR-21).
 */
const CONCEPTS = [
  { keys: ['投影', '顶掉', '界面弄没', '聊天区变空白'], vector: [1, 0, 0, 0] },
  { keys: ['迁移', '升级', '旧库'], vector: [0, 1, 0, 0] },
  { keys: ['无关', '天气'], vector: [0, 0, 1, 0] },
];

function vectorFor(text) {
  for (const concept of CONCEPTS) {
    if (concept.keys.some(key => text.includes(key))) return concept.vector;
  }
  return [0, 0, 0, 1];
}

async function startServer() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
      const data = inputs.map(text => ({ embedding: vectorFor(String(text)) }));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}/v1/embeddings` };
}

async function withSemantic(fn) {
  const { server, url } = await startServer();
  const previous = {
    url: process.env.OMNI_EMBED_URL,
    model: process.env.OMNI_EMBED_MODEL,
    key: process.env.OMNI_EMBED_KEY,
  };
  process.env.OMNI_EMBED_URL = url;
  process.env.OMNI_EMBED_MODEL = 'mock-embed';
  delete process.env.OMNI_EMBED_KEY;
  try {
    await fn(url);
  } finally {
    for (const [key, value] of Object.entries({
      OMNI_EMBED_URL: previous.url,
      OMNI_EMBED_MODEL: previous.model,
      OMNI_EMBED_KEY: previous.key,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise(resolve => server.close(resolve));
  }
}

test('FR-21 a paraphrase with zero shared characters recalls the note', async () => {
  await withSemantic(async () => {
    const app = await boot();
    await app.call('memory_write', {
      kind: 'note',
      text: '调用 inspectSession 会把实时投影顶掉，聊天区变空白',
      importance: 0.9,
    });

    const hit = await app.call('memory_search', { query: '那个把界面弄没的坑' });
    assert.equal(hit.value.hits.length, 1, 'semantic route should recall the note');
    const first = hit.value.hits[0];
    assert.ok(first.vectorScore > 0, 'vector route must contribute');
    assert.equal(first.lexicalScore ?? null, null, 'lexical route cannot match this query');
  });
});

test('FR-21 the same query finds nothing on the hashed backend', async () => {
  const previous = process.env.OMNI_EMBED_URL;
  delete process.env.OMNI_EMBED_URL; // fall back to hashed n-grams
  try {
    const app = await boot();
    await app.call('memory_write', {
      kind: 'note',
      text: '调用 inspectSession 会把实时投影顶掉，聊天区变空白',
      importance: 0.9,
    });
    const hit = await app.call('memory_search', { query: '那个把界面弄没的坑' });
    assert.equal(hit.value.hits.length, 0, 'hashed backend has no synonym recall');
  } finally {
    if (previous !== undefined) process.env.OMNI_EMBED_URL = previous;
  }
});

test('FR-21 the remote backend still answers when the endpoint is down', async () => {
  const previous = process.env.OMNI_EMBED_URL;
  process.env.OMNI_EMBED_URL = 'http://127.0.0.1:9/v1/embeddings'; // nothing listens
  process.env.OMNI_EMBED_TIMEOUT_MS = '300';
  try {
    const app = await boot();
    await app.call('memory_write', { kind: 'note', text: '远程嵌入不可用时的兜底笔记' });
    const hit = await app.call('memory_search', { query: '远程嵌入不可用' });
    assert.equal(hit.value.hits.length, 1, 'lexical route must still answer');
  } finally {
    delete process.env.OMNI_EMBED_TIMEOUT_MS;
    if (previous === undefined) delete process.env.OMNI_EMBED_URL;
    else process.env.OMNI_EMBED_URL = previous;
  }
});
