import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { boot, fakeReq, fakeRes } from './helpers.mjs';

/**
 * 用公开 API 稳定触发 remote 向量队列满。
 *
 * index.js 的 flushPendingVectors 只在 runSearch 和 reindex 里调用，因此
 * “只写不搜” 会把 pendingVectors 累积到 MAX_PENDING_VECTORS(4096)，此后每次
 * enqueueVector 都会递增 vectorDropped 并刷新 vectorLastDropAt。/omni-memory/status
 * 本身不 flush，正好可以在不破坏现场的情况下读取计数。
 *
 * 远端端点用本地 OpenAI-compatible stub 承接搜索时的 flush，不访问任何外部服务。
 */

const MAX_PENDING_VECTORS = 4096; // 与 index.js:98 保持一致
const EXTRA_WRITES = 5;

const ENV_KEYS = [
  'DSH_HOME',
  'OMNI_HOME',
  'OMNI_DISABLE_SEMANTIC',
  'OMNI_DISABLE_VECTOR',
  'OMNI_SCOPE_JUDGE',
  'OMNI_EMBED_URL',
  'OMNI_EMBED_MODEL',
  'OMNI_EMBED_KEY',
  'OMNI_EMBED_TIMEOUT_MS',
  'OMNI_EMBED_RETRIES',
  'OMNI_EMBED_BATCH',
];

function snapshotEnv() {
  return ENV_KEYS.map(key => [key, process.env[key]]);
}

function restoreEnv(snapshot) {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function startEmbeddingStub(dim = 8) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      calls += 1;
      let texts = [];
      try { texts = JSON.parse(raw).input ?? []; } catch { /* 空请求给空 data */ }
      const embedding = Array.from({ length: dim }, (_, i) => (i === 0 ? 1 : 0.01));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        object: 'list',
        model: 'stub-embed',
        data: texts.map((text, index) => ({ object: 'embedding', index, embedding })),
      }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1/embeddings`,
    get calls() { return calls; },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

// boot() 的 ctx.effect 丢弃了模块注册的 store 释放器；openStore() 是导出的，
// 可用它拿到同一个缓存 store 并在删除临时目录前关掉连接（含 WAL 落盘）。
function closeApp(app) {
  try { app.mod.openStore().db.close(); } catch { /* 可能尚未打开 store */ }
}

async function readStatus(app) {
  const { res, json } = fakeRes();
  await app.route('/omni-memory/status').handler(fakeReq('/omni-memory/status'), res);
  return json();
}

test('remote 向量队列写满后 dropped/lastDropAt 生效，搜索可 flush', { timeout: 120_000 }, async t => {
  const env = snapshotEnv();
  const home = mkdtempSync(path.join(tmpdir(), 'omni-vector-saturation-'));
  const stub = await startEmbeddingStub();
  let app;
  try {
    // 确保只写隔离目录，不碰生产库；显式配置 remote 后端才会启用入队路径。
    delete process.env.OMNI_HOME;
    process.env.DSH_HOME = home;
    process.env.OMNI_DISABLE_SEMANTIC = '1';
    process.env.OMNI_SCOPE_JUDGE = 'off';
    delete process.env.OMNI_DISABLE_VECTOR;
    process.env.OMNI_EMBED_URL = stub.url;
    process.env.OMNI_EMBED_MODEL = 'stub-embed';
    process.env.OMNI_EMBED_TIMEOUT_MS = '2000';
    process.env.OMNI_EMBED_RETRIES = '0';
    process.env.OMNI_EMBED_BATCH = '512';

    app = await boot({ home });
    const total = MAX_PENDING_VECTORS + EXTRA_WRITES;
    const writeStarted = performance.now();
    for (let i = 0; i < total; i += 1) {
      await app.call('memory_write', {
        kind: 'note',
        scope: 'global',
        text: `向量队列饱和测试笔记 ${i} ${String(i).padStart(5, '0')} xyz`,
      });
    }
    const writeMs = Math.round(performance.now() - writeStarted);
    t.diagnostic(`只写不搜 ${total} 条耗时 ${writeMs}ms`);

    const before = await readStatus(app);
    assert.equal(before.ok, true);
    assert.equal(before.embedding.kind, 'remote');
    assert.equal(stub.calls, 0, '写入阶段不应触发远端 embed 请求（不应 flush）');
    assert.equal(before.stats.notes, total);
    assert.equal(before.embedding.pending, MAX_PENDING_VECTORS, '队列应停在容量上限');
    assert.ok(before.embedding.dropped >= 1, `dropped 应 >= 1，实际 ${before.embedding.dropped}`);
    assert.ok(before.embedding.lastDropAt > 0, `lastDropAt 应 > 0，实际 ${before.embedding.lastDropAt}`);

    const hits = await app.call('memory_search', { query: '向量队列饱和测试笔记', scope: 'all' });
    assert.ok(Array.isArray(hits.value.hits));
    assert.ok(stub.calls > 0, '搜索应触发远端 embed（维度探测 + 批量 flush）');

    const after = await readStatus(app);
    assert.equal(after.embedding.dropped, before.embedding.dropped, 'flush 不应重置累计丢弃数');
    assert.equal(after.embedding.lastDropAt, before.embedding.lastDropAt);
    assert.ok(
      after.embedding.pending < before.embedding.pending,
      `搜索后队列应减少：${before.embedding.pending} -> ${after.embedding.pending}`,
    );

    const db = new DatabaseSync(path.join(home, 'memory', 'omni.db'));
    try {
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM vectors').get();
      assert.ok(n >= 1, 'flush 应把向量真正写入 vectors 表，证明 dropped 不是假计数');
    } finally {
      db.close();
    }
  } finally {
    closeApp(app);
    await stub.close();
    restoreEnv(env);
    rmSync(home, { recursive: true, force: true });
  }
});
