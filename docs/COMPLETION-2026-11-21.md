# 全息记忆 3.9.0：自动捕获、巩固、重排与拆分

日期：2026-11-21

## 已完成

### P0 会话自动捕获闭环

- schema v13 新增 `note_candidates`，带 `status/scope/ts` 与 `hash/scope/status` 索引；旧库通过迁移和 repair 自动补表。
- `memory_ingest`：任意宿主的一轮 user/assistant 对话写入 chunks，并抽取最多 3 条 pending 候选；确定性规则，不调用模型，不直接写正式 note。
- `memory_candidate`：`list / accept / reject`；accept 才落为 note，source 为 `chunk:<id> · candidate:<id>`，自动去重；reject 保留 reason。
- `scope=all` 拒写；默认候选范围当前项目 + global；单条正文上限 4000 字。
- HTTP：`POST /omni-memory/ingest`、`GET /omni-memory/candidates`、`POST /omni-memory/candidate`；POST 支持 JSON body 或 query 参数，均要求 loopback + `x-omni-csrf: 1`。
- CLI：`omni ingest`、`omni candidates`、`omni candidate`；`omni ingest --stdin` 解析 Claude Code hook 的 `prompt` / `last_assistant_message` / message content。

### P1 巩固与分层画像

- `memory_consolidate`：同一 `problemKey` + 同一精确 scope 的活跃笔记压成来源链摘要；默认 dry-run，`apply` 才写。
- 摘要按 `[已验证] / [未验证] / [失败尝试] / [已过期]` 分组；旧行只写 `superseded_by`，不删除；reuse/recall/useful/misleading 计数汇总。
- `scope=all/project` 被拒绝；少于 `minNotes`（2..10）返回不足。
- 画像显式分为 `## 全局`、`## 当前项目`，跨项目视图为 `## 其他项目`，事实段保留；`memory_profile` 与注入画像共用同一构建路径，仍受 1200 字预算约束。

### P1 检索重排与语义入口

- `lib/rerank-provider.mjs`：Cohere / Jina / SiliconFlow / 自建兼容端点；未配置 `OMNI_RERANK_*` 时零额外延迟，失败静默回落融合排序。
- `memory_search` 增加 `rerank` 开关；HTTP `/search?rerank=0` 可关闭；CLI `omni search --rerank` 可显式开启。
- `OMNI_EMBED_PROVIDER` 新增 `ollama`、`lmstudio` 预设；默认仍是零配置 hashed 向量，不强制下载模型。
- 同一文本同时命中 chunk 与已接受 note 时，最终结果优先保留 note/fact，不再让原始 chunk 遮住结论。

### 核心拆分

- 候选抽取规则移入 `lib/capture-rules.mjs`，`index.js` 只保留调用；新增 `test/capture-rules.test.mjs`。
- 重排提供方独立为 `lib/rerank-provider.mjs`，`npm run check` 覆盖两个新模块的语法。

## 验证结果

- `npm test`：**275/275 通过**（新增 ingest 7、consolidation 4、rerank 3、capture rules 4）。
- `npm run check`：文档与语法检查通过；当前计数 **23 工具 / 20 路由 / schema v13 / 3.9.0 / 28 ADR**。
- `npm run bench:golden`：recall **1.0**、MRR **0.927**，门槛 recall≥0.85 / MRR≥0.9 通过，重排与去重改造未降低黄金集。
- 线上服务已重启为 **3.9.0 / 25 个工具**（含 `memory_context`、`memory_rules`），OpenAPI 导出 10 条 path；`GET /omni-memory/candidates` 在真实库上返回 200。
- 临时库端到端验证：ingest → candidates → accept → 两条同 problemKey note → consolidate 干跑 → apply → `memory_get` 取到来源链摘要。

## 明确边界

- 候选抽取是确定性规则，尚未接 LLM 筛选；好处是零成本、可预测，坏处是复杂表述可能漏抽。
- cross-encoder rerank 需要用户配置端点；没有端点时不假装有语义重排。
- 语义向量默认仍是 hashed n-gram；要真语义，配置远程端点或本机 Ollama / LM Studio。
- 核心拆分是渐进的：先拆出新功能模块（capture-rules、rerank-provider），未把 5896 行的 `index.js` 一次性打散。
