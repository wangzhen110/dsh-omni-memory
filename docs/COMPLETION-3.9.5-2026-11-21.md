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
- `npm pack --dry-run`：`local-omni-memory-3.9.5.tgz`，90 entries，18.4 MB 压缩 / 41.0 MB 解包；GAP/INTEGRATION-PROBE/RECHECK-3.9.2/3.9.3 未入包。

## 后续测试加固（同日，至 348 用例）

3.9.5 发布后补了两层测试防护网，不改运行时、不改检索逻辑：

- 属性层：新增 `test/property.test.mjs`、`test/property-reliability.test.mjs`、`test/fuzz-inputs.test.mjs`、`test/property-ranking.test.mjs`、`test/property-concurrency.test.mjs`、`test/property-scope-alias.test.mjs`，共 24 条不变量/模糊属性。
- 回归层：新增 `test/fault-injection.test.mjs`（FTS/bigram/vector/edge 缺失或损坏、写锁、semantic 降级）、`test/semantic-reliability-regression.test.mjs`（GC 错误字段、队列丢弃、scope-alias CLI、冷却期早退后回填）、`test/http-security.test.mjs`（路径穿越、非 loopback、Origin/CSRF、超大 body）；`test/rerank.test.mjs` +5、`test/embed-provider.test.mjs` +3。合计新增 22 条。
- 第五轮再补 13 条：`test/install-smoke.test.mjs`（npm pack → 隔离 consumer 安装 → 写入召回）、`test/perf-budget.test.mjs`（10k/100k 行 p95 预算）、`test/backup-edge.test.mjs`（坏快照/事务回滚/scope 保真）、`test/http-lifecycle.test.mjs`（端口冲突/重启/跨实例）、`test/vector-queue-saturation.test.mjs`（4101 条写满队列后计数与 flush）。总数 313 → 348。
- `fast-check` 只进入 `devDependencies`（`^4.10.3`），运行时 `dependencies` 仍为空；`package-lock.json` 固化测试依赖。
- 完整 `npm test` **348/348**；`npm run check` 同步为 348 / 23 内核工具 / 25 MCP 工具 / 20 路由 / 31 ADR / 3.9.5；`bench:golden` 仍 `pass:true`。
- 6 组变异测试验证属性有效：禁用 scope 隔离、跳过 amend 派生清理、去掉拆句去重、反转 exact 排序、去掉平台大小写归一、把冷却期早退改回旧 bug，均能命中对应测试；源码变异已还原。
- 跨进程验证：两个独立 node 进程共享隔离库，进程 A 写/墓碑后退出，进程 B 冷启动清扫，死行派生索引为 0、活行不受损、GC marker=15 且无错误。
- 剩余未自动化：真实 macOS/Linux 文件系统大小写矩阵、浏览器级面板交互、7788 注销/休眠恢复与 Windows 服务常驻、1M 行长压、慢速请求/连接耗尽类网络韧性；均依赖外部环境，不是当前测试缺口。实测边界（HTTP 超大 body 断连、MCP HTTP CSRF 较宽、队列阈值不可调、语义后端降级未测）保留在属性记录中，不冒充已修。

## 未纳入

- 旧键没有路径证据时仍不会自动猜测合并；本版提供显式 CLI，不提供自动 basename 批量合并。
- 7788 仍是登录后计划任务，注销/关机/休眠会停；要注销后常驻需改 Windows 服务/S4U，属于部署形态变更。
- 历史复核报告 `RECHECK-3.9.2/3.9.3`、`GAP-REVIEW` 未纳入版本库。

## 发布

- 版本号、CHANGELOG、README、DESIGN、REFERENCE、THREAT-MODEL 同步到 3.9.5。
- 发布提交 `ab5dc99`（`fix: close semantic reliability debt (3.9.5)`）与发布报告 `3208efe` 均已推送 `origin/main`；后续文档计数修正提交以远端 HEAD 为准。
- 7788 服务在提交后重启，`health` 返回 `version:"3.9.5"`、`project:"proj:全息记忆#30534c"`、`tools:25`；`/omni-memory/status` 的 `semantic.gcError` 为空、`embedding.dropped:0`、`backfillDone:true`。
- 计划任务 `OmniMemory7788` 保持 `Running`；node 与父 PowerShell 的 `MainWindowTitle` 均为空，无 cmd 黑框。注销/关机/休眠仍会停服，常驻化未在本版改变。
- 真实库 `scope-alias --list` 返回既有两条映射：`proj:全息记忆#deff23 → proj:全息记忆#30534c`、`proj:专业知识#cb9453 → proj:专业知识#967a81`；未执行新的手工合并。
