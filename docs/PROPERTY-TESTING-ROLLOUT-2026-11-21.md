# 属性测试落地记录（2026-11-21）

## 背景

用户问「推荐的这几个都装吗？」并要求继续完成未完成任务。诊断工具清单里 6 类工具性质不同，判断如下：

| 工具 | 决定 | 理由 |
|---|---|---|
| `fast-check` (T1) | **已装、已落地** | 属性测试专治不变量违背——前几轮真实抓到的 bug（陈旧向量、scope 绕过、墓碑残留、输入校验）全是不变量问题，投入产出比最高 |
| `jazzer.js` (T2) | 暂不装 | 覆盖率引导 fuzz 需要插桩 + native 构建，对零依赖项目侵入大；本轮先用更轻的 `fast-check` 任意输入生成器覆盖同类入口，收益已拿到。若后续要对 MCP 帧解析/SQL 参数做深度 fuzz 再单独评估 |
| CodeQL / codexqa / claude-audit | 不作为项目依赖 | 外部 CLI / skill，发布门禁或人工评审时按需用，涉及源码外发判断 |
| eslint 安全规则 / crap4ts | 暂不装 | 优先级低，裁剪后接 `npm run check` 即可，本轮不动 |

核心原则：**只装测试期 devDependency，绝不进运行时 `dependencies`**。安装后 `package.json` 的 `dependencies` 仍为空，运行时零依赖不变。

## 实际改动

1. `npm install -D fast-check` → `devDependencies: { "fast-check": "^4.10.3" }`（2 个包、0 漏洞），生成 `package-lock.json`。
2. 新增 `test/property.test.mjs`：4 条属性，每条 60 组随机输入。
3. 同步测试数 289 → 293：README（badge / 测试行 / npm test 提示）、docs/DESIGN.md（NFR-10 / NFR-12 / M6）、docs/CHANGELOG.md（3.9.5 条目加说明）。

## 四条不变量属性

| # | 属性 | 钉死的不变量 | 对应历史 bug |
|---|---|---|---|
| 1 | 写入→problemKey 精确召回往返 | 存进去的笔记必按 key 召回同一 id、内容一致 | 3.9.2 陈旧向量 / GC 误删导致「写入成功≠可检索」 |
| 2 | 项目 scope 不跨项目泄漏 | projA 私有笔记不得在 projB 召回，但 projA 自己能召回 | 反复排查的 scope 绕过 / JOIN 漏过滤 |
| 3 | 墓碑后不可召回 | forget 后该 id 不再出现在任何召回 | 派生索引 GC 残留导致死笔记复活 |
| 4 | 任意文本安全存储 + 越界参数拒绝 | SQL 片段 / 控制字符 / CJK / 超长文本都能存能取；importance/limit/scope=all 越界必拒 | 参数化 SQL 回归 / 输入校验缺失 |

第 4 条的 `nasty` 生成器含 `"'; DROP TABLE notes; --"`、反斜杠转义注入、CJK+控制字符、纯空白、3900 字符长文本。

## 有效性证据：变异测试

属性测试容易写成「永远通过的摆设」。为证明有效，做了一次变异测试：

- 临时在 `index.js:scopeClause` 注入 `if (scope) return { sql: '', params: [] };`（让所有 scope 失效）。
- 跑 `node --test test/property.test.mjs`：**恰好只有属性 2（scope 隔离）失败**，其余 3 条继续通过。
- 立即从备份还原 `index.js`，`git diff index.js` 为空，还原后属性测试 4/4 全绿。

这证明每条属性锁定各自对应的不变量，且测试对真实回归敏感。

## 门禁结果（独立复跑）

| 门禁 | 结果 |
|---|---|
| `npm test` | **293/293**（新增 4 条属性 × 60 随机输入） |
| `npm run check` | 一致：293 / 23 内核工具 / 25 MCP 工具 / 20 路由 / 31 ADR / 3.9.5；semantic assets OK |
| `npm run bench:golden` | `pass: true`，MRR 未退化 |

## 一个踩坑记录（供后续写测试参考）

fast-check 4.x 中，**异步断言函数必须用 `fc.asyncProperty`，不能用 `fc.property`**。用后者配 async 函数时，返回的 Promise 被 fast-check 判为 `false`，表现为「Property failed by returning false」且反例被 shrink 到无意义的最小值，极具误导性。本次排查花了几轮才定位。helpers 的 `app.call` 是 async，因此本项目所有属性都走 `fc.asyncProperty`。

## 第二轮：3.9.5 可靠性属性测试（同日追加）

用户报「有更新了，准备齐全就开始测试」。核对发现远端 `origin/main` 从 `3208efe` 前进到 `5c50de5`，但二者 **tree hash 完全相同**（`e22d17e1`），父提交/时间/信息一致——只是同一个文档提交被重新签了一次（历史重写），**内容零变化**。本地属性测试仍有效。准备齐全，遂开始第二轮深度测试。

新增 `test/property-reliability.test.mjs`，针对 3.9.5 新改的语义可靠性逻辑（tree hash 已确认包含这些修复）：

| # | 属性 | 钉死的不变量 | 对应 3.9.5 修复 |
|---|---|---|---|
| 1 | amend 后派生索引全清 | 旧 note 的 bigram/vector/FTS/semantic_vectors 全部归零、旧行被 supersede | 替代路径从只清 semantic 改为 `dropDerivedIndexes` 清全索引 |
| 2 | 墓碑跨重开不复活 | forget 后重开 store，死行派生索引仍清、不可召回，活行不受损 | prune 原子化 + marker 仅成功时写入 |
| 3 | 混合变更库完整性 | 任意 write/amend/forget 序列后 `PRAGMA integrity_check=ok`、计数自洽 | 事务边界回归 |

每条 50 组随机输入。踩坑：属性 1 首版用两个独立随机文本，相等时 amend 正确抛「new text is identical」——这是项目正确行为，非 bug；改为新文本带固定差异后缀后消除误报。

**变异测试**：把 amend 路径的 `dropDerivedIndexes` 改为跳过（模拟 3.9.2 旧 bug）→ 恰好只有属性 1 失败，属性 2/3 通过 → 还原后全绿。再次证明属性锁定各自不变量。

**真·跨进程验证**（补单进程属性测试之盲）：用两个独立 node 进程共享隔离 home——进程 A 写 2 条并墓碑 1 条后退出；进程 B 全新冷启动触发启动清扫：`keepAlive=true`、死行 `bigrams/vectors/fts` 全为 0、活行 bigram=7 完好、GC marker=`15` 无错误、召回 keep=1/drop=0。临时文件已清理。

## 最终门禁（第二轮后）

| 门禁 | 结果 |
|---|---|
| `npm test` | **296/296**（4 条核心属性 + 3 条可靠性属性，共 7 条属性测试） |
| `npm run check` | 一致：296 / 23 / 25 / 20 / 31 ADR / 3.9.5；semantic assets OK |
| `npm run bench:golden` | `pass: true`，MRR 未退化 |
| 变异测试 ×2 | 禁用 scope 隔离→仅隔离属性失败；禁用 amend GC→仅 amend 属性失败 |
| 跨进程 GC | 冷启动清扫正确、活行不误删、死行不可召回 |

## 第三轮：全方位深度测试（同日，一次性完成）

用户要求「全方位无死角的全面检测，不要分阶段，一次性全部完成，给完整报告」。本轮把此前明确列出的四类硬骨头一次做全：**任意字符串入口 fuzz、RRF 排序不变量、并发竞态、scope_alias 边界**。新增 4 个测试文件、17 条属性、313 总用例。

### 范围与工具决策

| 方向 | 测试文件 | 手段 | 为何不用 jazzer.js |
|---|---|---|---|
| 任意字符串 fuzz | `test/fuzz-inputs.test.mjs` | fast-check 任意值/结构化恶意输入直打导出纯函数 | MCP 分发与拆句是纯函数，`createProtocol().handle()` 可直接喂任意 JSON-RPC；jazzer.js 要 native 插桩 + 覆盖率引导，对零依赖零构建项目侵入过大、收益不额外 |
| RRF 排序 | `test/property-ranking.test.mjs` | 属性钉死顺序契约，走公开 `memory_search` | — |
| 并发竞态 | `test/property-concurrency.test.mjs` | `Promise.all` 交错 async 调用 + 落盘 `integrity_check` | 与项目自带 `concurrency.test.mjs`（真多进程 worker）互补 |
| scope_alias 边界 | `test/property-scope-alias.test.mjs` | 导出纯函数 + 真实库的迁移/环图 | — |

### 17 条属性一览

**Fuzz（4 条）**
1. MCP 分发器对任意 JSON-RPC 值不抛未捕获异常，发出必为合法 v2 帧（`jsonrpc:'2.0'` + result/error）、请求 id 回显——按真实 `serveStdio` 的 `JSON.parse → dispatch().catch → write()` 语义建模。
2. `tools/call` 恶意工具名：空名 → `invalidParams`(-32602)，未知名 → `isError` 工具结果，均不执行、不抛。
3. `candidateSentences` 输出契约：不抛、去重、每条 8..400 字符、排除纯 URL / 纯路径、去空白、trim。
4. `extractCandidateTexts` 角色/上限/分数边界：非 user/assistant 角色返回空、条数 ≤ `MAX_CANDIDATES_PER_CHUNK`、confidence ∈ [0,1]。

**RRF 排序（5 条）**
1. exact problemKey 命中按真实结局排序 verified > unverified > failed。
2. exact 命中是硬优先：即使词面诱饵 importance=0.99，exact 命中仍排第一。
3. feedback 单调：useful 抬高 score、misleading 压低 score（Bayesian 平滑不变量）。
4. status 过滤精确：`status=verified` 只返回 verified，不漏其他结局。
5. 排序确定性：同查询重复执行顺序完全一致。

**并发（4 条）**
1. 同 problemKey 并发写：N 条全部落库、id 各异、逐条可召回。
2. 并发 feedback 无丢失更新：M 次 useful 投票计数恰好 = M。
3. 跨 scope 并发写隔离：各 scope 只看到自己的私密笔记。
4. 混合并发风暴（写/查/fact 交错）后 `PRAGMA integrity_check=ok`。

**scope_alias（4 条）**
1. 平台大小写正确性：win32/darwin 同路径任意大小写归一为同一键，linux 保留大小写，分隔符拼写归一。
2. legacy 键保大小写、全小写路径下 legacy == canonical。
3. `migrateScopeAlias` 幂等无损：迁移后源空、目标满、重复迁移 no-op、alias 记录正确。
4. 循环别名图（2..24 环）在 16 跳上限下必然终止、不挂起。

### 有效性证据：三组变异测试

| 变异 | 注入的回归 | 结果 |
|---|---|---|
| 去掉 `candidateSentences` 去重 | `return out` 替代 `return [...new Set(out)]` | **首轮未被捕获**——随机文本几乎不会生成两条完全相同的合格句子。补入「必然重复」的输入常量后，恰好 F3 失败、其余 3 条通过 |
| 反转 exact 优先级 | `[...result.hits, ...exact]` | 恰好 R2 失败，其余 4 条通过 |
| 去掉平台大小写归一 | `identity = normalized` | 恰好 S1/S2（大小写相关）失败，S3/S4（迁移/环）通过 |

三处源码变异均已从备份还原，`git diff index.js lib/capture-rules.mjs` 为空。**第一个变异首轮漏检是本轮最有价值的发现**——它证明「写了断言」不等于「断言真的在守护」，必须靠变异反证；补输入后才真正锁定。此前两轮的变异（禁 scope 隔离、禁 amend GC）同样精确命中，累计 5 组变异验证。

### 踩坑记录（供后续参考）

1. `fc.stringOf` 不是 fast-check 4 的 API，字符池要写 `fc.string({ unit: fc.constantFrom(...) })`。
2. `memory_feedback` 有 scope 隔离：笔记写在 `proj:fb-*` 时，feedback 省略 scope 会用 session 当前项目而抛「outside the current project」；跨项目审计需显式 `scope:'all'`。
3. `PRAGMA integrity_check` 返回键名是 `integrity_check`（不是 `integrity_check()`），读错键会得到 undefined 假失败。
4. `boot()` 只设 `DSH_HOME`、不建库；DB 文件在首次工具调用触发 `openStore()` 时才创建，直接开 db 文件会报「unable to open database file」——需先做一次写入。
5. 异步属性必须用 `fc.asyncProperty`（第二轮已记录，本轮全部遵循）。

### 最终门禁（第三轮后）

| 门禁 | 结果 |
|---|---|
| `npm test` | **313/313**（核心 4 + 可靠性 3 + fuzz 4 + 排序 5 + 并发 4 + alias 4 = 24 条属性/模糊测试） |
| `npm run check` | 一致：313 / 23 内核工具 / 25 MCP 工具 / 20 路由 / 31 ADR / 3.9.5；semantic assets OK 11 文件 37.5 MiB |
| `npm run bench:golden` | `pass: true`，MRR 0.979 未退化 |
| 变异测试 | 本轮 3 组 + 前两轮 2 组 = 累计 5 组，均精确命中对应属性 |
| 临时改动 | 全部还原，`git diff` 源码为空；未碰生产库 |

## 结论

累计投入 1 个测试期依赖（`fast-check`，运行时 `dependencies` 仍为空），换来 **24 条不变量/模糊属性**（核心、可靠性、fuzz、排序、并发、alias 六维）的持续守护，5 组变异测试证明它们对真实回归敏感。全程只读源码（仅变异测试临时改动并已还原），未碰生产库，检索质量与零依赖运行时不受影响。这是审计工具清单中落地收益最高、代价最小的一步。未发现新的 P0/P1 缺陷——本轮是「加固防护网」，不是「修 bug」。

## 第四轮：把“列为后续”的缺口补做（2026-11-21，同日）

用户指出：既然要求“全面检测”，就不该把剩余缺口只列成后续优先级。本轮把能稳定自动化的部分一次补完，不依赖外部环境。

### 新增 22 条用例

| 文件 | 条数 | 覆盖 |
|---|---:|---|
| `test/fault-injection.test.mjs`（新） | 6 | 删除/破坏 `notes_fts`、删除 `bigrams`/`vectors`、删除 `edges`、第二连接写锁、`semantic_vectors` 缺失后的降级与恢复 |
| `test/semantic-reliability-regression.test.mjs`（新） | 4 | GC 失败元数据→`status.semantic.gcError/gcFailedAt`；丢弃计数字段；`scope-alias` CLI 预览/`--apply`；**冷却期早退后回填恢复**（真实构造 `retryAt` 未来 + `pending` 空 + `backfillDone=false`，精确覆盖 3.9.5 那一行） |
| `test/rerank.test.mjs`（+5） | 5 | fetch 抛错/Abort 超时、500、畸形 JSON、全零分回落，均验证 `memory_search` 保持原融合顺序 |
| `test/embed-provider.test.mjs`（+3） | 3 | 持续 5xx 到重试上限、批次失败整批丢弃、真实 AbortSignal 超时 |
| `test/http-security.test.mjs`（新） | 4 | 10 种静态路径穿越变体、非 loopback 变更拒绝、Origin/CSRF 变体、畸形/超大 body 受控 |

### 门禁

| 门禁 | 结果 |
|---|---|
| `npm test` | **335/335**（313 → 335，新增 22 条） |
| `npm run check` | 一致：335 / 23 内核工具 / 25 MCP 工具 / 20 路由 / 31 ADR / 3.9.5 |
| `npm run bench:golden` | `pass:true`，MRR 0.979 未退化 |

**变异验证**：把 `runSemanticWorker` 冷却早退分支临时改回旧 bug（`scheduleNext = state.pending.size > 0`），只跑 `test/semantic-reliability-regression.test.mjs` → 恰好第 4 条「冷却期早退后未完成的语义回填仍会恢复」失败（11s 超时后 `indexed=0`），其余 3 条通过；还原后 4/4 全绿，`git diff -- index.js` 为空。证明该回归测试确实钉住 3.9.5 那一行，不是摆设。

### 本轮实测发现（不掩盖）

1. **HTTP 超大 body（>4MB）是断连，不是显式 4xx**：`hosts/http/server.mjs:74` 的 `readBody` 超限后 `reject` + `req.destroy()`，客户端拿到 `TypeError: fetch failed`；服务不崩、后续 `/health` 仍 200。属受控错误，但不符合常见 413 契约。测试按真实实现接受断连并记录诊断。
2. **CSRF 校验强度在不同入口不一致**：REST 变更路由严格要求 `x-omni-csrf: 1`；MCP over HTTP 的 `mcpMutationAllowed` 在没有 Origin 时仅凭 `content-type: application/json` 即放行。当前测试按实现断言，不把它当缺陷放行。
3. **队列满 `dropped/lastDropAt` 只做了字段存在性与初值断言**：`vectorDropped` / `semantic.dropped` 的阈值硬编码 4096，未导出、无环境变量可调；用公开 API 稳定写满 4096 条且不 flush 不可靠，因此没有写假行为测试。这是本轮唯一没有真正行为覆盖的 3.9.5 观测字段。
4. **启用语义模型后的故障降级未在自动测试覆盖**：helpers 默认 `OMNI_DISABLE_SEMANTIC=1`，避免每条用例背上 ~216MB RSS；`semantic_vectors` 缺失只验证了状态读取降级，不验证启用语义后端时的搜索降级。

### 仍未自动化（明确边界）

- 10k/100k p95 阈值进 CI、1M 行长压测（ADR-020 的“未来”项）；
- 真实 macOS/Linux 文件系统大小写矩阵、浏览器级面板交互、7788 注销/休眠恢复与 Windows 服务常驻；
- `npm pack` 消费端安装冒烟（此前仅 `INTEGRATION-PROBE` 手工一次）。

本轮未改任何运行时源码，测试全部使用隔离 home；生产库未被指向。

## 第五轮：继续关闭“仍未自动化”清单（2026-11-21，同日）

用户再次追问“还有哪些没测试的”。把上一轮声明的边界再收窄：能稳定自动化的全部补做，只剩依赖外部 OS / 浏览器 / 系统服务的项。

### 新增 13 条用例（335 → 348）

| 文件 | 条数 | 覆盖 |
|---|---:|---|
| `test/install-smoke.test.mjs`（新） | 1 | `npm pack` → 隔离 consumer `npm install --omit=dev` → 从安装后的 `index.js` 写入/召回；校验 13 个运行时模型资产存在；全程约 5s，无网络 |
| `test/perf-budget.test.mjs`（新） | 2 | ADR-020 的 10k / 100k 行 p95 < 300ms 且 `hitTotal > 0`；默认都跑，实测 10k p95 3.4ms / 100k p95 2.6ms |
| `test/backup-edge.test.mjs`（新） | 6 | 未来版本快照拒绝、截断/畸形 JSON、错误 format、类型错误中途失败事务回滚、global+两项目 scope 保真、旧版快照兼容 |
| `test/http-lifecycle.test.mjs`（新） | 3 | 同端口关闭后重启、端口冲突受控 reject（EADDRINUSE）且首实例仍健康、同 home 顺序实例 A 写 B 召回 |
| `test/vector-queue-saturation.test.mjs`（新） | 1 | 远程后端写 4101 条不搜索，`pending` 停在 4096、`dropped>=1`、`lastDropAt>0`；随后搜索触发 flush 且计数保持不变，证明不是假计数 |

### 门禁

| 门禁 | 结果 |
|---|---|
| `npm test` | **348/348**（335 → 348，新增 13 条） |
| `npm run check` | 一致：348 / 23 内核工具 / 25 MCP 工具 / 20 路由 / 31 ADR / 3.9.5 |
| `npm run bench:golden` | `pass:true`，MRR 0.979 未退化 |

### 实测发现

1. **向量队列满计数已能稳定行为覆盖**：只有 remote 后端会入队（hashed 同步落库），写入 4101 条约 6–7s、RSS 稳定、无隐式 flush；多出的 5 条确定被丢弃。这补上了第四轮唯一只做字段断言的缺口。
2. **导入的“坏行”分两类**：缺 `text` 的行被 `stats.skipped` 跳过而非报错；真正触发回滚的是类型错误（如 `importance: 'not-a-number'` → NOT NULL 约束失败）。`mergeSnapshot` 整体包在事务中，坏行之前的好行也不残留。
3. **HTTP 端口冲突是受控 Promise reject**（`server.once('error', reject)`），不会产生未捕获异常；同端口 close→restart 可干净复用。优雅关闭在途请求没有确定性构造手段，未写时序断言。
4. **安装冒烟可离线完成**：运行时 `dependencies` 为空，`npm install --omit=dev` 不需要网络；唯一非致命现象是 Node 22 的 SQLite ExperimentalWarning。

### 现在仍未自动化（只剩外部环境依赖）

- 真实 macOS/Linux 文件系统大小写矩阵（当前只把 `platform` 参数喂给纯函数）；
- 浏览器级面板交互（星图、按钮、错误提示）——需要引入浏览器驱动，超出当前零运行时依赖策略；
- 7788 在注销/关机/休眠后的恢复与 Windows 服务/S4U 常驻（属部署形态，不是代码路径）；
- 1M 行 + 5 万向量 + 100 万 bigram 长压（手工记录，避免 CI 时长失控）；
- 慢速请求 / 连接耗尽类网络韧性测试（需要专门压测工具，非 node:test 合适场景）。

本轮未改任何运行时源码，未碰生产库；所有新测试使用隔离 home 与临时 tarball/consumer 目录。
