# 全息记忆 3.9.3 完成报告：语义索引生命周期治理

日期：2026-11-21
版本：3.9.3
状态：实现、测试、文档完成；待提交并推送 GitHub main，待重启本机 7788 服务。

## 背景

`docs/RECHECK-3.9.2-2026-11-21.md` 对 3.9.2 的复核结论是：功能承诺成立（同义改写召回实测命中），但新增的 `semantic_vectors` 与语义队列把 3.9.1 的三类长期治理问题原样复现：派生索引无 GC、队列满静默丢弃、失败无退避；另外发现同一 key 在推理飞行中重入队会被旧快照吞掉，留下永久陈旧向量。

本次只处理这些与语义索引可靠性直接相关的缺陷，不改变检索权重、模型或零配置路线。

## 修复

- **同一 key 不被吞**：`pending` entry 增加单调 `seq`；flush 在推理前筛掉已被覆盖的 entry，推理后再次复核，旧快照不写入陈旧向量、也不删除新 entry。
- **派生 GC**：`memory_forget`、`memory_compact` 在事务内删除 FTS / bigram / `vectors` / `semantic_vectors`；`memory_amend`、dream replace、consolidate 删除旧 note 的语义向量；rollback 恢复原 note 时重新入队。启动按 `semantic_gc_version` 执行一次孤儿向量清扫。
- **队列可观测**：队列满时记 `dropped` / `lastDropAt`，通过 `semantic` 状态暴露，不再静默。
- **失败退避**：写入/查询失败按 1s→30s 指数退避，暴露 `failureCount` / `retryAt`；冷却期内语义路线直接返回空，词面 / hashed / 图继续服务。
- **短租约 + 续租**：`semantic-backfill` TTL 从 600s 降为 120s，worker 每批前续租；崩溃恢复从最长 10 分钟降到 2 分钟。
- **强制重算**：`memory_reindex({semantic:true, semanticForce:true})` 先清当前模型签名，再按源文本重建；默认仍只补缺行。
- **清理**：`dispose` 清除 worker timer 与 exit listener；启动清扫用 marker 避免重复全表删除。

## 验证

- `npm test`：**285/285 通过**。
- `npm run check`：285 tests / 23 tools / 20 routes / 30 ADRs / 3.9.3；`semantic assets OK: 11 files, 37.5 MiB`。
- `npm run bench:golden`：词面 0.776、hashed 混合 0.927、四路完整 0.979，`pass:true`。
- `npm pack --dry-run`：`@local/omni-memory@3.9.3`，87 个文件，解包 41,013,698 字节（十进制），压缩 18,421,980 字节（十进制）。
- 新增用例：遗忘/修订后语义行数下降；首次 flush 期间 amend 不被旧快照吞掉。

## 未纳入

- P1 跨平台路径大小写归一：直接改 `projectKeyFromCwd` 会改变已有项目的 scope 键，需要独立的 scope alias 迁移，不能和本次可靠性修复混在一起。
- P3 二进制 SHA-256/SRI、`nulls` 口径统一、reindex 计数口径、Xenova 署名与发布文档单位：不影响本次语义索引生命周期，留在后续治理。
- ANN：语义仍扫描最近 5000 条向量 + 词面候选；十万级以上冷门纯语义命中仍需 ANN。

## 发布

（待提交与部署后补）
