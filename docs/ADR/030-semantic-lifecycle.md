# ADR-030：语义索引生命周期与失败治理

- 状态：已采纳（3.9.3）
- 日期：2026-11-21
- 关联：ADR-029、FR-41、NFR-07、NFR-10

## 背景

3.9.2 把本地语义设为默认路线后，复核发现 3.9.1 的三类长期治理问题在新表和新队列上原样复现：

1. `semantic_vectors` 没有 GC：遗忘、compact、替代只墓碑主表，派生向量继续占磁盘。
2. 队列满时 `enqueueSemantic` 直接 `return`，没有计数或告警；模型持续失败时新写入会永久失去语义索引且不可观测。
3. `flushSemanticPending` 失败只写 `lastError`，没有退避；模型损坏时每次搜索都重走加载和推理失败。
4. 回填租约 TTL 600 秒，进程崩溃后其他宿主最长等待 10 分钟。
5. 同一 `(kind,id)` 在推理飞行中再次入队时，旧快照完成后的 `delete(key)` 会吞掉新条目，留下“旧向量永久陈旧、新文本不再入索引”的状态。

这些不是功能缺陷，但会让一个默认开启的索引在长期运行后变得不可信。

## 决策

### 1. 版本化待处理项

`pending` 仍按 `(kind,id)` 去重，但每条 entry 带单调递增 `seq`。flush 在推理前后都复核当前 entry 的 `seq`：

- 推理前：只嵌入仍为当前版本的 entry。
- 推理后：若同一 key 已被新文本覆盖，跳过旧向量的写入，也不删除新 entry。
- 新 entry 由下一轮 worker 或同轮 search 的再次 flush 处理。

这样旧快照不能写入陈旧向量，也不能吞掉新版本。

### 2. 事务内 GC

- `memory_forget`、`memory_compact`：删除主表派生索引，包括 FTS、bigram、hashed/remote `vectors` 与 `semantic_vectors`。
- `memory_amend`、dream replace、consolidate、dream rollback：替代时删除旧 note 的语义向量；rollback 恢复原 note 时重新入队。
- 启动时按 `schema_version` 执行一次孤儿清扫，标记 `semantic_gc_version`，避免每次启动重复全表删除。
- 派生数据没有审计价值；主表墓碑和事实有效期仍是审计来源。

### 3. 队列与失败可观测

- `SEMANTIC_MAX_PENDING` 满时记 `dropped` 与 `lastDropAt`，在 `semantic` 状态中返回，不再静默。
- 失败按 1s→30s 指数退避；`failureCount`、`retryAt` 进入状态。
- 冷却期内 `semanticSearch` 直接返回空，词面/hashed/图路线继续服务；worker 在 `retryAt` 后重新排程。

### 4. 短租约 + 续租

- `semantic-backfill` TTL 从 600 秒缩短为 120 秒。
- worker 每批处理前通过 `renewLease` 续租；只有仍持有旧 token 才更新。
- 崩溃后最多 2 分钟即可被其他宿主接管；长回填不会因 TTL 到期被误抢。

### 5. 强制重算入口

`memory_reindex({semantic:true, semanticForce:true})` 先删除当前模型签名的 `semantic_vectors`，再按源文本重建。用于模型升级、旧签名残留或人工修复；默认 reindex 仍只补缺行。

## 后果

- 正面：删除/替代不再留下永久膨胀；同一 key 的并发改写可自愈；模型损坏不会在每次搜索时反复加载；崩溃恢复从 10 分钟降到 2 分钟。
- 代价：`semanticForce` 会短暂清空当前签名索引，重建期间语义召回退化到词面/hashed/图；需要调用方显式选择。
- 未解决：语义扫描仍是最近 5000 条 + 词面候选，十万级以上冷门纯语义命中仍需 ANN；P1 跨平台路径大小写归一会改变已有项目键，需要独立的 scope alias 迁移，未并入本次。
