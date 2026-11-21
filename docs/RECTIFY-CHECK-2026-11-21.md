# 整改复核报告（3.7.0）

复核日期：2026-11-21
复核对象：提交 `3fa87d2`（并发/测试稳定）、`6289807`（召回质量闭环，v3.7.0）
复核方式：只读审计 + 端到端实测（隔离临时库 + 独立端口 + 工具层直接调用），**未修改任何源码**
测试基线：`npm test` **251/251 通过**（实测），版本 3.7.0，schema v12，工具 20 个

---

## 一、结论摘要

用户按上两轮建议完成了第一批整改。复核结果：

| 类别 | 结论 |
|---|---|
| 上轮 P0/P1 安全加固 | ✅ 已修，交叉复核确认（`19d5de4`） |
| Windows 测试 EBUSY + 并发首次打开 WAL 竞态 | ✅ 已修，根因定位准确（busy_timeout 提前） |
| 质量门禁（MRR/recall 断言进 CI） | ✅ 已落地，真断言 `process.exitCode=1` |
| 文本分地板移除 | ✅ 已落地 |
| 反馈闭环 / 渐进披露 / 修订链 | ⚠️ 已落地但**引入 3 个新缺陷**（见第三节） |
| 我上轮"project 伪层级未修" | ❌ **我的误报，已纠正**（见第二节） |
| 自动抽取 / rerank / 宿主无关 ingest / 拆 core | ⏸ 本轮明确未做（符合其自述边界） |

整体：这轮整改质量**高于平均水平**——根因分析到位、门禁是真的、测试全绿。但新增的 3 个工具里，`memory_amend` 有确凿的字段丢失 bug，`memory_feedback`/`memory_amend` 有跨项目越权缺口，二者都直接伤害本项目最看重的"记忆隔离 + 可审计 + 质量闭环"。建议作为 P1 优先修复后再发布。

---

## 二、必须纠正的一点：project 伪层级是我上轮误报

我上轮（REVIEW-2026-11-21）称"P1-6 `/search`、`/node` 仍把 project 当字面 scope，前端选项目层搜索/点选失效"。**这是错的。**

`index.js:1532-1540` 的 `scopeClause` 与 `index.js:1686-1689` 的 `scopeAllows` 均已正确处理 `scope === 'project'`（→ `LIKE 'proj:%'`）。我当时只看 `/search`、`/node` 两级路由的 `requested === 'all' ? null : ...` 就下结论，漏追了它们把 scope 透传给 `runSearch → scopeClause` 的路径。

端到端实测（临时库写入 global + proj:alpha + proj:beta 三条同词记忆）：

```
/search?scope=project    → 2 命中（alpha、beta），排除 global    ✅
/search?scope=all        → 3 命中（含 global）                  ✅
/search?scope=global     → 1 命中（仅 global）                  ✅
/search?scope=proj:alpha → 2 命中（alpha + global）             ✅
/node?node=n:alpha&scope=project → 200                          ✅
/node?node=n:alpha&scope=global  → 404                          ✅
/node?node=n:global&scope=project → 404                         ✅
```

结论：伪层级语义完全正确。`docs/REVIEW-2026-11-21-VERIFICATION.md` 的复核是对的；我已在 `REVIEW-2026-11-21.md` 中把该项标记为误报。新增的生命周期回归用例保留，有价值。

---

## 三、本次整改新引入的缺陷

### N-1【P1·确凿 bug】`memory_amend` 修订时丢失关键字段，破坏质量闭环与审计保真

- **位置**：`index.js:3770-3791`（INSERT 只写 13 个字段）
- **实证**：构造一条 `contested=1 / verification='verified' / recall_count=9 / useful_count=7 / misleading_count=2` 的笔记后 amend，实测新行：

| 字段 | 修订前 | 修订后 | 结果 |
|---|---|---|---|
| contested | 1 | 0 | ❌ 争议标记丢失 |
| verification | 'verified' | null | ❌ 验证状态丢失 |
| verified_at | 时间戳 | null | ❌ 丢失 |
| recall_count | 9 | 0 | ❌ 归零 |
| useful_count | 7 | 0 | ❌ 归零 |
| misleading_count | 2 | 0 | ❌ 归零 |
| source | 'ORIGINAL-SOURCE' | 'FIX-REASON' | ⚠️ 被 reason 覆盖 |

- **影响**：
  1. 一条经过验证、高价值、被多次投票"useful"的笔记，amend 一次后所有质量信号清零，刚建的 `feedbackBoost` 排序优势立即消失——**质量闭环被自己的修订工具击穿**。
  2. `contested`/`verification` 丢失，与项目"只增不改、可审计、可回滚"的核心价值观冲突：修订本应保留沿革，实际却抹掉了核验历史。
  3. `source` 被 reason 覆盖，丢失原始出处；reason 本应另存。
- **修复建议**：INSERT 补齐 `contested, verification, verified_at, recall_count, useful_count, misleading_count` 全部透传；`source` 保留 `old.source`，把 `reason` 写入独立字段或拼进 `evidence`；反馈计数是否重置应显式决策并在文档中写明（建议保留，因排序价值属于"结论"而非"文字"）。

### N-2【P1·越权】`memory_feedback` / `memory_amend` 无 scope 归属校验，可跨项目篡改

- **位置**：`index.js:3592`（feedback `execute(args = {})`）、`index.js:3751`（amend `execute(args = {})`）——均**不接收 `toolContext`**，仅按 id 操作；对比同一批新增的 `memory_get` 在 `index.js:3667` 接收 `toolContext` 并用 `scopeClause` 过滤。
- **实证**：在 `session-BETA`（global 层）上下文里：
  - `memory_get` 读 `proj:alpha#1` → **正确拒绝**（`not active or out of scope`）
  - `memory_feedback` 给 `proj:alpha#1` 投 useful → **成功**（质量分被外部项目改动）
  - `memory_amend` 修订 `proj:alpha#1` → **成功**（生成 #3 修订，覆盖 alpha 项目笔记）
- **影响**：同一进程内多个 agent / 多个项目共用一份库时（项目 3.5.0 起就支持多进程/多 agent 共享），一个项目的 agent 可投票污染或改写另一项目的记忆。这与项目反复强调的"按项目分层、不串味"承诺直接冲突，也绕过了刚建的反馈质量信号。
- **修复建议**：两个工具都改为 `execute(args, toolContext = {})`，用 `currentProject(toolContext)` 得到当前 scope，对目标行做 `scopeClause` 校验；跨项目操作需显式 `scope='all'`（审计语义），与 `memory_get` 保持一致。补一条跨项目拒绝的回归用例。

### N-3【P2·语义误导】`recall_count` 名不副实，只在 feedback 时递增

- **位置**：`index.js:3610`（唯一递增点），search / profile 命中路径均不更新。
- **说明**：`recall_count`/`last_recall_at` 对外暴露为"召回次数/最近召回时间"（`feedbackFields` → `recallCount`/`lastFeedbackAt`），但实际只在模型调用 `memory_feedback` 时 +1。真实召回（`runSearch`、`buildProfileText`）完全不记。模型看到 `recallCount=1` 会以为是"这条被召回过 1 次"，其实是"被反馈过 1 次"。
- **影响**：误导模型判断；无法据此回答"哪条记忆真正被高频召回"。属语义/可观测性缺陷，不影响排序正确性。
- **修复建议**：要么在召回命中路径真实递增（注意写入放大与只读语义冲突），要么更名为 `feedbackCount` 并把 `last_recall_at` 改为 `last_feedback_at`，避免歧义。

---

## 四、确认修复无误的项（不再重复列出证据）

1. **`/mcp` 回环校验**（`hosts/http/server.mjs`）：已加 socket 回环前置判断；`--bind 0.0.0.0` 不再暴露全工具面。
2. **规则托管区块标记**：不成对/多块时拒绝改写，孤立 start 不再吞用户正文。
3. **contested 事实隔离**：profile 与 persona 证据只读 `contested=0`。
4. **维护租约**：migrate / 回填 / 远端恢复均在租约内；租约带持有者 token，过期持有者不会误删新租约。
5. **JSON-RPC 合规**：`id:null` 按合法请求处理；通知不回帧；内部异常仅在有 id 时回复。
6. **并发首次打开 WAL 竞态**：`busy_timeout` 提前到 `journal_mode=WAL` 之前，根因定位准确。
7. **Windows 测试清理**：EBUSY/ENOTEMPTY/EPERM 条件重试，测试连跑稳定（本次 251/251 通过）。
8. **质量门禁**：`bench/golden.mjs:103-122` 真实断言 `recall≥0.85 / MRR≥0.9`，CI 增加 `npm run bench:golden`；地板移除后默认后端 MRR 0.927、recall 1.0。
9. **渐进披露 `memory_get`**：scope 默认当前项目+global，跨项目需显式 `all`，实测隔离正确（见第二节）。

---

## 五、下一步建议（按优先级）

1. **先修 N-1、N-2**（P1，各约十几行代码 + 回归用例）。N-1 是确凿数据 bug；N-2 是隔离承诺缺口。二者都不需要架构改动，性价比极高。
2. **修 N-3 命名**（P2，低风险，避免误导模型与后续维护者）。
3. 修完把 schema 从 v12 保持（N-1/N-2 不需要迁移，只是工具逻辑；N-3 若改名才需要 v13）。
4. 之后才进入第二梯队：自动抽取候选、rerank、宿主无关 ingest、渐进拆 core——这些是本轮明确未做、也确实更重的投入。

---

## 复核边界声明

本次为只读静态审计 + 隔离环境动态实测，未运行生产数据、未 profiler 压测；MRR/延迟数字引用项目自测，未独立复跑 golden 基准（但已验证门禁断言代码为真实 fail-fast）。所有缺陷结论均附可复现路径与实测输出。未修改任何源码/文档，仅新增本报告。

---

## 六、二次复核（3.7.1，2026-11-21 09:44）

用户针对 N-1/N-2/N-3 发布修复提交 `6c7af16`（版本 3.7.1）。独立复核结论：**三项全部修复到位，实测确认**。

| 缺陷 | 修复状态 | 复核证据 |
|---|---|---|
| N-1 amend 字段丢失 | ✅ 已修 | `index.js:3770-3791` INSERT 补齐全部审计字段。实测 amend 后 `source=ORIG-SRC`（未被 reason 覆盖）、`contested=1`、`verification=verified`、`verified_at` 保留、`recall/useful/misleading_count=9/7/2` 全部保留；`reason` 以 `[amend] FIX-REASON` 追加进 `evidence`。 |
| N-2 跨项目越权 | ✅ 已修 | 两个工具均接收 `toolContext` 并用 `scopeClause` 过滤。实测 global 上下文对 `proj:alpha` 笔记执行 feedback / amend 均被拒绝（`not found, inactive, or outside the current project`）；显式 `scope=all` 放行走审计路径。与 `memory_get` 语义一致。 |
| N-3 命名误导 | ✅ 已修 | `feedbackFields` 对外改为 `feedbackCount` / `lastFeedbackAt`；全仓无 `recallCount` 对外残留（仅剩 import 兼容读取 `note.recallCount` 的容错分支）；schema v12 物理列名保持不变，无迁移。 |

- 测试：新增 2 项回归（字段保真、跨项目拒绝），当时 `npm test` **253/253 通过**（exit=0）；3.7.2 宿主适配层加入后为 **257/257 通过**。
- 门禁：当时 `npm run check` 全绿（253 tests / 20 tools / 13 routes / 28 ADRs / v3.7.1）；3.7.2 后为 257 tests / 16 routes / v3.7.2。
- 变更范围核对：仅 `index.js` + 测试 + 文档，**未触碰 schema 版本**（保持 v12），修复为纯工具逻辑，风险面小。
- 命名细节确认：CHANGELOG 写"由 `lastRecallAt` 改为 `lastFeedbackAt`"，而上一版对外字段实为 `lastFeedbackAt`（`feedbackFields` 早已用此名），此处 CHANGELOG 表述略有出入，但不影响功能与契约，属文案瑕疵，可不修。

**二次复核边界**：静态审查 + 隔离临时库实测，未跑生产数据；独立复用了自己构造的字段保真/越权场景，未依赖项目新增测试作为唯一证据。本次仅更新本报告与工作日志，未改动任何源码。

---

## 七、增量复核（3.7.2，2026-11-21 10:04）

提交 `416ce84` 新增"宿主适配层"——这是第二梯队"能力脱离 DSH"方向的一次落地，与上轮建议同向。改动：新增 3 条 HTTP 路由（`/packet`、`/openapi.json`、`/tool`）+ `docs/HOST-ADAPTERS.md`，index.js +269 行。版本 3.7.2。

**结论：纯增量功能，安全边界干净，未发现新缺陷。**

端到端实测（独立临时库 + 独立端口，非项目自带测试）：

| 检查项 | 结果 |
|---|---|
| `GET /packet` json | 200，`scope=proj:alpha#2dc7b2`（cwd 推导正确）、含 text / generatedAt |
| `GET /packet?format=text` | 200，`text/plain; charset=utf-8` |
| `GET /openapi.json` | 200，声明 6 条路径，与实际路由一致 |
| `POST /tool` 无 CSRF 头 | **403** ✅ |
| `GET /tool`（方法错误） | **405** ✅ |
| `POST /tool` 非白名单 `memory_export` | **400**，被 allowlist 拦下 ✅ |
| `POST /tool` 白名单 `memory_write` 带 `scope=proj:evil` | 200，写入落到 `proj:evil`——写入按 scope 参数，属本地可信 agent 能力，符合设计 |
| `/tool` 调 feedback/amend 改 `proj:evil` 笔记（空 toolContext） | **400 拒绝**（`outside the current project`）——上轮 N-2 的隔离修复在新桥上同样生效 ✅ |

- 工具桥白名单 8 个：`write/search/solution_report/feedback/get/amend/profile/timeline`，维护面（export/import/dream/compact/reindex）未暴露——收敛合理。
- `buildMemoryPacket` 的 `limit`/`budget` 有 clamp（1..10 / 400..4000），`scope=project` 时画像回退 global 并注明语义——边界处理到位。
- 测试：`npm test` **257/257**（exit=0），新增 `test/host-adapter.test.mjs` 4 项；`npm run check` 全绿（257 tests / 20 tools / **16 routes** / 28 ADRs / v3.7.2），文档闸门已同步更新路由数。

**仍未做**（第二梯队剩余）：自动事实抽取、cross-encoder rerank、宿主无关 ingest 的会话自动捕获（当前 packet 是拉取式 sidecar，非自动捕获）、渐进拆 core。新增适配层解决的是"接入通道"，不是"自动沉淀"。
