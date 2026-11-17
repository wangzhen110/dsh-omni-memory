# ADR-017：HTTP 安全边界、默认隐私与 v2.3.2 评审修复

- 状态：已采纳
- 日期：2026-11-17
- 关联：ADR-012（自动召回）、ADR-013（项目分层）、ADR-015（模型复核对齐）、NFR-08

## 背景

v2.3.1 经历了一次外部代码级评审，指出三类问题：

1. **记忆正确性**：被替代笔记（`superseded_by`）、过期事实（`valid_to`）仍进入画像、搜索、向量与图召回；远程嵌入重启后维度归零导致语义检索静默失效；多步写入无事务。
2. **隔离性**：HTTP 裸搜索跨项目、工具层继承“最近一次装配”的项目、未知 agent 复用他人召回、`scope=all` 写入成为孤儿。
3. **安全与隐私**：`forget` 允许 GET（可被浏览器 `<img>` 触发 CSRF）；loopback 不构成认证；默认 `OMNI_SCOPE_JUDGE=always` 会把写入正文发送给模型，与 README 的隐私声明矛盾；模型空输出会把项目笔记提升为 `global`。

## 决策

### 1. 写入路径只接受 POST + 同源校验

`forget` 拒绝 GET（405），只接受 POST，并要求：

- `x-omni-csrf: 1` 自定义头：浏览器跨站请求无法在不触发 CORS 预检的情况下携带；
- `Origin` 与 `Host` 同源，避免跨站表单/图片触发。

**边界**：这不是身份认证。同用户的本机进程仍可调用读接口；插件没有宿主级凭据，不能假装拥有它。要更强隔离需要宿主提供命名管道/进程凭据，见“残余风险”。

### 2. 隐私默认值：`OMNI_SCOPE_JUDGE=off`

默认不把任何正文发给模型。只有用户显式设置 `auto` / `always` 才启用复核；judge 队列上限 256，无 `llm` 服务时不入队，空输出保留规则判定（不再把项目笔记提升为 global）。

### 3. 未知上下文一律 fail-closed 到 global

- 删除跨请求的 `lastProjectAny` / `lastRecallAny` 兜底；
- `projectForScope()` 无 `scope.id` 返回 `null`（只注入全局层）；
- 工具调用从 `ToolRunContext.agent.id` 取调用者；拿不到就不猜项目；
- `memory_profile` / `memory_timeline` / `/node` 都接受显式 `scope`，默认 global；
- 写入 `scope=all` 直接报错（`all` 是只读审计视图）。

副作用：并发会话/子 agent 不再错层，代价是**识别不到调用者时项目层不注入**（宁可少注入，不跨项目泄漏）。

### 4. 远程嵌入维度持久化 + 失败退避

- `remote_dim` / `remote_signature` 写入 `meta`，启动时 `restoreRemoteState()` 恢复；
- 维度未知时用固定探针文本调用一次 `/embeddings` 确认维度；
- 端点不可用时记录失败时间，**60 秒内不再探测**，避免每次检索都叠加超时（本轮补充）；
- 旧库缺向量按批回填（每批 32 行/表），并提供 `memory_reindex` 显式重建。

### 5. 事务与历史状态

- 多步写入使用 `BEGIN IMMEDIATE ... COMMIT`，失败回滚；
- `chunks` 唯一约束从全局 `(hash)` 改为部分索引 `(hash, IFNULL(scope,'global')) WHERE deleted_at IS NULL`，墓碑后同文可重捕，跨项目同文各存一条；
- 事实失效时同步失效对应 `edges`，失效范围限定同 scope。

## 残余风险（明确不假装解决）

1. **数据库明文**：SQLite 未加密，备份/同步即复制全部记忆。需要加密时应在外层用磁盘/容器加密。
2. **本机进程信任**：读接口无鉴权，同用户进程可读全库；写接口只有 CSRF 防护。
3. **1M 行性能**：p95 ≈ 911ms，超出 NFR-01 的 300ms 预算；适合个人规模（≤10 万行）。
4. **旧库 2 字索引**：`bigrams` 每次打开每层最多回填 10,000 行，大库需要多次打开或显式重建。
5. **dream 自动替代**：`unsupported` 仍会用证据原文替换，质量风险存在；替代链在 revision 3 停止。
6. **多值关系与实体消歧**：`(subject, relation)` 仍是近似单值，实体无 NER/类型；属于数据模型改造，单独立项。
7. **`projectForScope` 依赖 `scope.id`**：若宿主不提供可解析的 scope id，项目层不会自动注入（fail-closed）；需在真实 DSH 版本上验证。

## 验证

- 163 / 163 自动化用例通过；其中 `test/fixes.test.mjs` 的 11 条回归由本仓库重新编写，覆盖：superseded/valid_to 过滤、跨 scope 事实隔离、HTTP scope 默认值、`scope=all` 拒绝、无 context fail-closed、CSRF、墓碑重捕、跨项目同文、`memory_reindex`、v6→v7 迁移。
- 用真实数据库副本（12 notes / 6 facts / 423 chunks）执行 v6→v7 迁移：行数不变、`chunks_hash_active` 建立、`edges.scope` 回填 8/9、`bigrams` 回填 41,241 条。
- 真机安装后验证 `/omni-memory/*` 路由、面板与写入 scope。
