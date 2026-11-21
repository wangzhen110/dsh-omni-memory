import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { boot, fakeReq, fakeRes } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'hosts', 'cli.mjs');
const REAL_MODEL_DIR = path.join(ROOT, 'models', 'bge-small-zh-v1.5');
const ENV_KEYS = [
  'DSH_HOME',
  'OMNI_HOME',
  'OMNI_DISABLE_SEMANTIC',
  'OMNI_DISABLE_VECTOR',
  'OMNI_SEMANTIC_MODEL_DIR',
  'OMNI_SEMANTIC_MODEL',
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

async function readStatus(app) {
  const { res, json } = fakeRes();
  await app.route('/omni-memory/status').handler(fakeReq('/omni-memory/status'), res);
  return json();
}

function dbPath(home) {
  return path.join(home, 'memory', 'omni.db');
}

// boot() 的 ctx.effect 丢弃了模块注册的 store 释放器；openStore() 是导出的，
// 可用它拿到同一个缓存 store 并在清理临时目录前关掉连接（含 WAL 落盘）。
function closeApp(app) {
  try { app.mod.openStore().db.close(); } catch { /* 可能尚未打开store */ }
}

// ---------------------------------------------------------------------------
// 1. 派生 GC 失败元数据 -> /omni-memory/status 的 semantic.gcError / gcFailedAt
// ---------------------------------------------------------------------------
test('GC 失败元数据写入 meta 后与 status 一致，清空后恢复为空', async () => {
  const env = snapshotEnv();
  const home = mkdtempSync(path.join(tmpdir(), 'omni-gc-status-'));
  let app;
  try {
    app = await boot({ home });
    app.mod.openStore(); // 确保 DB 文件与 memory 目录已创建
    const db = new DatabaseSync(dbPath(home));
    const put = db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)');

    put.run('semantic_gc_last_error', 'prune failed: disk I/O');
    put.run('semantic_gc_failed_at', '1760000000123');
    let body = await readStatus(app);
    assert.equal(body.ok, true);
    assert.equal(body.semantic.gcError, 'prune failed: disk I/O');
    assert.equal(body.semantic.gcFailedAt, 1760000000123);

    // 清空（模拟下一次成功 GC 后 metaSet(..., '') / 删除失败时间）。
    db.prepare('DELETE FROM meta WHERE key IN (?, ?)')
      .run('semantic_gc_last_error', 'semantic_gc_failed_at');
    body = await readStatus(app);
    assert.equal(body.semantic.gcError, '');
    assert.equal(body.semantic.gcFailedAt, null);
    db.close();
  } finally {
    closeApp(app);
    restoreEnv(env);
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. 向量队列丢弃计数器：状态字段存在性与初值
//
// `vectorDropped` / `vectorLastDropAt` 是 index.js 的模块级变量，仅在
// `enqueueVector`（remote 后端）遇到 `pendingVectors.size >= MAX_PENDING_VECTORS
// (4096)` 时才递增；语义侧对应 `state.dropped` / `state.lastDropAt`，阈值
// `SEMANTIC_MAX_PENDING = 4096`。两者都没有从 index.js 导出，也没有可下调阈值
// 的环境变量，公开工具里没有任何入口能直接操纵队列。要用公开行为触发一次丢弃
// 必须写满 4096 条 remote 向量且全程不触发 flush，结果依赖事件循环时序，无法
// 稳定复现。因此这里只断言字段存在与初值，不伪造队列满的假象。
// ---------------------------------------------------------------------------
test('embedding 与 semantic 的丢弃计数字段存在且初值为 0/null', async () => {
  const env = snapshotEnv();
  const home = mkdtempSync(path.join(tmpdir(), 'omni-drop-fields-'));
  let app;
  try {
    app = await boot({ home });
    const body = await readStatus(app);

    assert.ok(Object.hasOwn(body.embedding, 'dropped'));
    assert.ok(Object.hasOwn(body.embedding, 'lastDropAt'));
    assert.equal(body.embedding.dropped, 0);
    assert.equal(body.embedding.lastDropAt, null);

    assert.ok(Object.hasOwn(body.semantic, 'dropped'));
    assert.ok(Object.hasOwn(body.semantic, 'lastDropAt'));
    assert.equal(body.semantic.dropped, 0);
    assert.equal(body.semantic.lastDropAt, null);
  } finally {
    closeApp(app);
    restoreEnv(env);
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. CLI `omni scope-alias`：--list / 预览不迁移 / --apply 迁移且可审计
// ---------------------------------------------------------------------------
function runCli(args, home) {
  const env = { ...process.env, DSH_HOME: home, OMNI_HOME: home, OMNI_DISABLE_SEMANTIC: '1' };
  const result = spawnSync(process.execPath, [CLI, 'scope-alias', ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `CLI 失败: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

test('scope-alias CLI 预览不迁移，--apply 迁移并在 scope_aliases 留痕', async () => {
  const env = snapshotEnv();
  const home = mkdtempSync(path.join(tmpdir(), 'omni-scope-alias-cli-'));
  let app;
  try {
    const from = 'proj:cli-regression-old#111111';
    const to = 'proj:cli-regression-new#222222';
    app = await boot({ home });
    await app.call('memory_write', { kind: 'note', scope: from, text: 'CLI scope-alias 回归笔记' });

    // --list 正常返回（此时库已由上一步写入创建）。
    const listed = runCli(['--list'], home);
    assert.ok(Array.isArray(listed.aliases));

    // 预览：报告行数但不迁移。
    const preview = runCli(['--from', from, '--to', to], home);
    assert.equal(preview.from, from);
    assert.equal(preview.to, to);
    assert.equal(preview.applied, false);
    assert.equal(preview.fromHasRows, true);
    assert.equal(preview.migrated, undefined);

    {
      const db = new DatabaseSync(dbPath(home));
      assert.equal(
        db.prepare('SELECT COUNT(*) n FROM notes WHERE scope = ?').get(from).n, 1,
        '预览不得改动源 scope 的行',
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) n FROM scope_aliases WHERE alias = ?').get(from).n, 0,
        '预览不得写入别名审计',
      );
      db.close();
    }

    // --apply：真正迁移。
    const applied = runCli(['--from', from, '--to', to, '--apply'], home);
    assert.equal(applied.migrated, true);
    assert.equal(applied.notes, 1);

    {
      const db = new DatabaseSync(dbPath(home));
      assert.equal(db.prepare('SELECT COUNT(*) n FROM notes WHERE scope = ?').get(from).n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM notes WHERE scope = ?').get(to).n, 1);
      const alias = db.prepare('SELECT canonical FROM scope_aliases WHERE alias = ?').get(from);
      assert.equal(alias.canonical, to, '迁移必须在 scope_aliases 留下审计行');
      db.close();
    }

    // --list 之后能列出该审计行。
    const after = runCli(['--list'], home);
    assert.ok(after.aliases.some(row => row.alias === from && row.canonical === to));
  } finally {
    closeApp(app);
    restoreEnv(env);
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. 冷却期早退回归（3.9.5 关键行）
//
// 构造：先用损坏的本地模型触发一次失败，使 retryAt 落在未来、pending 为空、
// backfillDone=false；随后把模型目录切回真实模型。若 runSemanticWorker 在
// retryAt>now() 的早退分支没有补上 `|| !state.backfillDone`，后台 worker 再也不会
// 被调度，回填停滞；修复后冷却结束会继续回填。这里用公开行为（环境配置 + 工具
// + status 路由）验证回填确实恢复，不断言任何源码文本。
// ---------------------------------------------------------------------------
test('冷却期早退后未完成的语义回填仍会恢复', async () => {
  const env = snapshotEnv();
  const home = mkdtempSync(path.join(tmpdir(), 'omni-cooldown-'));
  const badModel = mkdtempSync(path.join(tmpdir(), 'omni-bad-model-'));
  let seed;
  let app;
  try {
    // 准备一个存在但内容损坏的模型目录：semanticConfig 认为模型存在，加载必然抛错。
    writeFileSync(path.join(badModel, 'model_int8.onnx'), 'not an onnx model');
    writeFileSync(path.join(badModel, 'tokenizer.json'), '{');
    writeFileSync(path.join(badModel, 'tokenizer_config.json'), '{');

    // 先在同一个 home 里用默认（语义禁用）实例写好待回填的笔记。
    seed = await boot({ home });
    for (let index = 0; index < 12; index += 1) {
      await seed.call('memory_write', {
        kind: 'note',
        text: `冷却期回填回归第 ${index} 条：磁盘满了如何释放系统盘`,
      });
    }

    // 用损坏模型启动语义实例，立即用一次搜索触发失败（pending 仍为空）。
    process.env.OMNI_SEMANTIC_MODEL_DIR = badModel;
    app = await boot({ home, semantic: true });
    await app.call('memory_search', { query: '冷却期回填' });

    const during = (await readStatus(app)).semantic;
    assert.ok(during.failureCount >= 1, '损坏模型应记录一次失败');
    assert.notEqual(during.retryAt, null, '失败后 retryAt 应落在未来');
    assert.equal(during.pending, 0, '搜索失败路径不应留下 pending');
    assert.equal(during.backfillDone, false, '回填尚未完成');

    // 切回真实模型；loadRuntime 在失败时会清空缓存，下一次推理会重新加载。
    process.env.OMNI_SEMANTIC_MODEL_DIR = REAL_MODEL_DIR;

    let status;
    let resumed = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      status = (await readStatus(app)).semantic;
      if (status.indexed >= 12 && status.backfillDone === true) {
        resumed = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(
      resumed, true,
      `冷却结束后回填未恢复: indexed=${status?.indexed} retryAt=${status?.retryAt} lastError=${status?.lastError}`,
    );
    assert.equal(status.failureCount, 0, '成功回填后应清除失败计数');
  } finally {
    closeApp(app);
    closeApp(seed);
    restoreEnv(env);
    rmSync(home, { recursive: true, force: true });
    rmSync(badModel, { recursive: true, force: true });
  }
});
