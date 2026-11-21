# 全息记忆 3.9.1：复核问题修复

日期：2026-11-21
基线：3.9.0（`fb8912d` + `70b045d`）
依据：`docs/RECHECK-3.9.0-2026-11-21.md`

## 已修复

### B1 英文自动捕获

- `lib/capture-rules.mjs` 改用 `Intl.Segmenter` 做分句，英文句点、常见缩写与中文标点都能正确拆分。
- 长英文转录不再被当成单条 >400 字符整段丢弃；`capture-rules` 新增英文短句/长文回归。

### B2 备份候选幂等

- `memory_import` 的候选去重改为按 `hash + scope` 查任意状态，不再只查 pending。
- 旧备份里的 pending 候选导入、本地接受/拒绝、再次导入同一文件时，不会把已审候选重新灌回队列。
- `test/backup.test.mjs` 增加“接受后再次导入不复活 pending”的断言。

### B3 scope 大小写

- 新增 `normalizeScopeInput`，统一归一 `all` / `project` / `global`。
- 覆盖 `memory_write`、`memory_ingest`、`memory_candidate`、`memory_consolidate`、`memory_search`、`memory_list` 及对应 HTTP 入口。
- `scope='ALL'` / `'All'` 不再绕过 `scope=all` 拒写；`decideScope` 的 `project` 解析为当前项目，不再写成字面 `project`。

### M-1 rerank 隐私告知

- README 隐私段明确：配置 `OMNI_RERANK_*` 会把 query 与候选正文发送到重排端点。
- DESIGN NFR-08、THREAT-MODEL 同步补充外发边界；默认 hashed 向量 + 无 rerank 完全不出机。

### M-2 rerank 分数与 exact 保护

- 融合分与 rerank 分先各自 min-max 归一化到 0..1，再按 25/75 混合，消除 RRF 0.016–0.05 与 rerank 0..1 的量级错配。
- exact `problemKey` 命中改为排序硬优先，不再依赖 +0.25 软加分；补 exact 不被高分弱命中反超的回归。
- 负 logits 不再被 `score > 0` 误判；全零/全等分视为无信号，直接回落。
- 只对 top-20 候选调用重排，限制付费端点成本。

### F1 候选字段保真

- accept 落 note 时保留候选原始 `ts`。
- `confidence` 映射到 `importance`（0.3–0.9），不再硬编码 0.55 / `now()`。

### 候选审核原子性

- `reviewNoteCandidate` 的 accept/reject 包在单个 `BEGIN IMMEDIATE` 事务内；事务内重新读取 pending 状态，写 note 与更新候选状态同进同退，不再依赖 dedupe 兜底。

### 低优先级边界

- `finalizeHits` 不再在达到 limit 时提前退出；排位靠后的 note/fact 仍可替换同文本 chunk，替换后按分数重排。
- `capProfileLines` 清理尾部空标题；画像分段只有标题 + 首条内容能放进预算时才写标题，避免空的 `## 当前项目`。

## 验证

- `npm test`：**280/280 通过**（新增英文拆句 1、scope 大小写 1、负分 rerank 1、exact 保护 1）。
- `npm run check`：**280 tests / 23 tools / 20 routes / 28 ADRs / 3.9.1**，文档一致。
- `npm run bench:golden`：recall **1.0**、MRR **0.927**、`pass: true`。

## 未改

- `memory_consolidate` 仍接受任意精确 scope（如 `proj:beta`），这是“显式运维操作”的设计取舍；HTTP 仍有 loopback + CSRF 兜底。
- 默认语义向量仍是 hashed；rerank 仍需显式配置端点才能真正生效。
- 候选抽取仍是确定性规则，不调用 LLM。
