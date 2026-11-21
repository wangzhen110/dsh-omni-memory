# 3.9.5 完成报告：语义可靠性收尾

日期：2026-11-21 · 版本：3.9.5 · 前置复核：`docs/RECHECK-3.9.3-2026-11-21.md`

## 结论

3.9.4 已关闭 P1 路径大小写分裂和 P3 资源校验。本版只处理复核报告里剩下的三个 P2 可靠性问题，并补上旧项目 scope 的人工迁移入口；不改检索权重、模型或默认行为。

## 修复

### 1. 冷却期早退漏调度

`runSemanticWorker` 在 `retryAt` 仍在未来时提前返回，原调度条件只有 `pending.size > 0`。当 pending 被清空而回填尚未完成时，冷却结束后没有唤醒源。现在统一为：

```js
scheduleNext = state.pending.size > 0 || !state.backfillDone;
```

### 2. GC 原子化与错误可见

`pruneSemanticVectors` 改为单个事务；三个派生表的删除要么全部成功，要么回滚，不再逐条 `catch` 吞掉。失败写入：

- `meta.semantic_gc_last_error`
- `meta.semantic_gc_failed_at`

并通过 `/omni-memory/status` 的 `semantic.gcError` / `gcFailedAt` 暴露。

`dropDerivedIndexes` 现在只对**实际存在的表**执行删除；已有表上的删除失败会让外层事务回滚，不再留下“主表已改、索引还在”的半状态。

### 3. 替代路径清理全部派生索引

`memory_amend`、dream replace、consolidate、dream rollback 原来只清 `semantic_vectors`。现在统一走 `dropDerivedIndexes`，清理 FTS / bigram / hashed/remote `vectors` / `semantic_vectors`；被替代或墓碑化的行不再长期占用派生表。

### 4. 远程向量队列可观测

`enqueueVector` 队列满时不再无声返回：记录 `dropped` / `lastDropAt`，`/omni-memory/status` 的 `embedding` 暴露，和 3.9.3 的语义队列计数保持同一口径。

### 5. 手工 scope 迁移入口

新增：

```powershell
omni scope-alias --from proj:旧名#旧哈希 --to proj:新名#新哈希 --apply
omni scope-alias --list
```

默认只预览 `fromHasRows` / `toHasRows`，`--apply` 才在事务内迁移 notes/facts/chunks/note_candidates/edges 与 `agent_project`。用于没有 `project_path` 证据、无法自动确认的历史旧键；不做 basename 猜测。

## 验证

- `npm test`：**289/289**（新增 `test/derived-gc.test.mjs`：amend 后旧 note 的 FTS / bigram / vector 为 0）。
- `npm run check`：`289 tests, 23 core tools / 25 MCP tools, 20 routes, 31 ADRs, version 3.9.5`；`semantic assets OK: 11 files, 37.5 MiB`。
- `node --check index.js` / `node --check hosts/cli.mjs` 通过。
- CLI 副本验证：`scope-alias --list`、`scope-alias --from ... --to ...` 预览均正常；`--apply` 在事务内执行并返回 `migrated:true`。
- `npm run bench:golden`：`pass:true`；检索链路未改，指标与 3.9.4 基线一致。
- `npm pack --dry-run`：`local-omni-memory-3.9.5.tgz`，89 entries，18.4 MB 压缩 / 41.0 MB 解包；GAP/INTEGRATION-PROBE/RECHECK-3.9.2/3.9.3 未入包。

## 未纳入

- 旧键没有路径证据时仍不会自动猜测合并；本版提供显式 CLI，不提供自动 basename 批量合并。
- 7788 仍是登录后计划任务，注销/关机/休眠会停；要注销后常驻需改 Windows 服务/S4U，属于部署形态变更。
- 历史复核报告 `RECHECK-3.9.2/3.9.3`、`GAP-REVIEW` 未纳入版本库。

## 发布

- 版本号、CHANGELOG、README、DESIGN、REFERENCE、THREAT-MODEL 同步到 3.9.5。
- 计划在测试与副本迁移通过后提交并推送 `origin/main`；7788 继续由隐藏计划任务静默拉起。
