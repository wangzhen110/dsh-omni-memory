# 全息记忆（Omni memory）

> 给 DeepSeek Harness 的长期记忆内核：**只增不改的原文留底 + 会自我校验的结论 + 按项目分层 + 三路混合召回 + 可复用的故障经验沉淀**。

> ⚠️ **许可提醒**：本项目采用 **全息记忆个人使用许可 1.1** —— 仅允许个人、非商业使用；
> **禁止任何形式的商业使用**，包括直接商用、修改后商用，以及复制、改写或提取本软件
> **源码/架构**后做商业替代、竞品或商业服务；且**必须署名作者**。
> 商用请走 [商业授权](#商业授权) 流程。

[![tests](https://img.shields.io/badge/tests-245%2F245-brightgreen)](#测试)
[![license](https://img.shields.io/badge/license-Personal%20Use%201.1-lightgrey)](LICENSE)

---

**完整机理与接口参考**：[`docs/REFERENCE.md`](docs/REFERENCE.md) —— schema、写入与检索机理、19 个工具、13 条路由、MCP 协议面、CLI、环境变量、AI 调用剧本。执行 `npm run memory:sync` 可把整本手册拆成笔记写进记忆库，之后用 `memory_search` 就能直接检索到。

## 它解决什么问题

普通对话记忆要么"全记"（噪声爆炸），要么"靠模型自觉"（漏记）。全息记忆把两件事拆开：

| 层 | 谁负责 | 特点 |
|---|---|---|
| **转录**（原文） | 系统自动 | 只增不改、可检索、可按上限墓碑化 |
| **结论**（笔记/事实） | 模型判断后写入 | 带来源、可校验、可遗忘、可修订 |
| **事实** | 结构化三元组 | 双时态（何时为真/何时失效），冲突自动失效旧值 |
| **实体图** | 事实自动生成 | 支持 2 跳关联召回 |
| **分层** | 按工作目录自动判定 | 全局规则 vs 项目专属，互不污染 |

## 核心能力

- **混合检索**：词面（FTS5 trigram + 中文二元索引）+ 向量（512 维字符 n-gram，可选接真语义嵌入）+ 图游走，RRF 融合排序
- **故障经验库**：笔记可带 `problemKey` 问题指纹、`solutionStatus`（verified / unverified / failed / expired）和证据；精确指纹优先命中，已验证解法排在失败尝试之前
- **复用闭环**：`memory_solution_report` 在真实复用后回写成功/失败/过期，成功累计 `reuseCount` 并标记 verified，失败尝试保留下来避免重复走死路
- **自动召回**：每轮用你的消息预取 top-3 注入上下文（可关）
- **模型复核归类（可选）**：写入先按规则落层；显式开启后，后台让模型复核，判错自动迁移并留痕。默认关闭，不把正文发给外部模型
- **冲突标记**：显式声明或近重复自动标记 `contested`，只标记不删除；画像与自动召回默认排除 contested
- **做梦校验**：离线拿转录核对笔记，发现"与原文矛盾"时**只标记为待复核**；替代需单条确认（`memory_dream_replace`），且可一键反替代
- **记忆星图**：整屏旋臂星系，拖拽旋转/滚轮缩放/分层切换；**单击任意星点弹出记忆卡**，搜索命中会亮起脉冲光环
- **活跃视图**：列表/搜索默认只显示活跃记忆；历史（被替代、已删除、已失效）通过面板「审计」查看并可单条**恢复**
- **备份/导出/导入**：`memory_export` 导出可移植 JSON（含墓碑），`memory_import` 合并导入（默认 dry-run），`memory_restore` 复活单条
- **多客户端并发**：同一台机器上多个 AI 客户端各起一个服务进程，共用一个 `omni.db`；写入等待而不是报锁错，去重与事实失效在写锁内完成，迁移/索引重建/做梦由全机唯一的租约持有者执行（见 [ADR-028](docs/ADR/028-multi-process-concurrency.md)）
- **隐私**：全部数据在本地 SQLite（`$DSH_HOME/memory/omni.db`），HTTP 只监听 loopback；写操作只接受 POST 并校验 Origin/CSRF 头

## 安装

### 插件市场

在 DSH 插件市场搜索「全息记忆 / Omni memory」安装，重启或刷新后左栏出现「全息记忆」入口。

### 本地安装（开发者）

```bash
cd memory-core
npm test          # 245 个用例
npm run check     # 语法与 JSON 校验
```

然后在 DSH 插件管理器中选择本地目录安装。

### 在 DSH 之外使用（MCP / HTTP / CLI）

同一份内核可以脱离 DSH 运行，三个入口共用一个本地记忆库：

- `hosts/mcp/bin.mjs` — 零依赖 stdio MCP 服务，Claude Code、Cursor、Cline、Codex CLI、Zed 都能接
- `hosts/http/server.mjs` — 独立面板 + REST（直接挂载插件原有的 13 条路由）+ HTTP 上的 MCP（`POST /mcp`）
- `hosts/cli.mjs` — `omni rules / context / search / serve / mcp`

**规则怎么送到模型**：MCP 没有系统提示注入点，所以准备五条通道，同一份文本、永不漂移：

1. `initialize` 返回的 `instructions`
2. `prompts/get` 的 `omni-bootstrap`（可带当前任务一起返回）
3. `resources/read` 的 `omni://rules`
4. 工具 `memory_rules`
5. `omni rules --write` 把托管区块写进项目自己的 `CLAUDE.md` / `AGENTS.md` / `.cursorrules` / `.clinerules`；区块幂等，可以挂在 SessionStart 钩子上反复执行

```bash
node hosts/mcp/bin.mjs            # stdio MCP
node hosts/cli.mjs serve          # 面板 http://127.0.0.1:7788
node hosts/cli.mjs rules --write  # 把规则写进项目规则文件
node hosts/cli.mjs context --query "当前任务"   # 给 hooks 拼上下文用
```

接入配置、能力边界与自检方法见 [`hosts/mcp/README.md`](hosts/mcp/README.md)。

## 配置

所有开关通过环境变量控制，**修改后需重启 DSH**。

| 变量 | 默认 | 说明 |
|---|---|---|
| `OMNI_HOME` | 先 `$DSH_HOME`，再 `~/.dsh` | 数据根目录；非 DSH 宿主靠它指向同一个库 |
| `OMNI_AUTO_RECALL` | 开 | `0` 关闭每轮自动召回 |
| `OMNI_SCOPE_JUDGE` | `off` | 模型复核归类：`off` / `auto` / `always`；开启后写入正文会发给复核模型 |
| `OMNI_JUDGE_PROVIDER` / `OMNI_JUDGE_MODEL` | 自动 | 指定复核用的模型 |
| `OMNI_PERSONA_MODEL` | `off` | `auto`/`on` 允许后台 persona 自动提炼调用宿主模型；默认只用离线规则 |
| `OMNI_EMBED_URL` | 未设置 | 接 OpenAI 兼容 `/embeddings` 启用真语义 |
| `OMNI_EMBED_MODEL` | `text-embedding-3-small` | 远程嵌入模型 |
| `OMNI_EMBED_KEY` | — | 远程嵌入鉴权 |
| `OMNI_EMBED_PROVIDER` | 未设置 | 预设：openai / dashscope / zhipu / siliconflow（自动填 url/model） |
| `OMNI_EMBED_BATCH` | `64` | 每请求最大输入条数 |
| `OMNI_EMBED_RETRIES` | `2` | 429/5xx 重试次数（250ms、750ms 退避） |
| `OMNI_EMBED_TIMEOUT_MS` | `10000` | 远程嵌入超时 |
| `OMNI_DREAM_INTERVAL_MS` | `0`（关） | 定时做梦校验 |
| `OMNI_DISABLE_VECTOR` | 未设置 | `1` 关闭向量路线（诊断用） |
| `OMNI_DISABLE_GRAPH` | 未设置 | `1` 关闭图路线 |

## 模型工具

| 工具 | 作用 |
|---|---|
| `memory_write` | 写入笔记 / 事实 / 原始观察；笔记可带 `problemKey` / `solutionStatus` / `evidence`（事实可声明 `cardinality: multi` 保留多值） |
| `memory_search` | 混合检索（支持全局 / 项目 / 全部）；可按 `problemKey` 精确查，按 `status` / `kind` 过滤 |
| `memory_solution_report` | 记录解法真实复用结果：`success` 标记 verified 并累计次数，`failed` / `expired` 更新状态 |
| `memory_profile` | 读取常驻画像 |
| `memory_timeline` | 某实体的时间线（事实 + 相关笔记） |
| `memory_forget` | 墓碑化一条记忆 |
| `memory_dream` | 拿转录核对笔记（默认 dry-run；`apply` 只标记，`commit` 才批量替代） |
| `memory_dream_proposals` | 列出待确认的替代候选（只读） |
| `memory_dream_replace` | 单条替代（需 `confirm: true`） |
| `memory_dream_rollback` | 反替代：复活原笔记、墓碑化生成笔记 |
| `memory_compact` | 转录增长治理（默认 dry-run） |
| `memory_reindex` | 回填缺失向量（hashed / remote）；`bigrams: true` 一次重建全库 CJK 两字索引 |
| `memory_link_entity` | 登记实体别名并合并事实/边（默认 dry-run） |
| `memory_persona` | 读取/修正/自动提炼用户设定：称呼 / 性格 / 习惯 / 偏好 / 其他；刷新默认保留手工字段，`useModel: true` 才调用宿主模型 |
| `memory_export` | 导出 JSON 备份（默认含墓碑；`activeOnly` 只导活跃） |
| `memory_import` | 合并导入备份（默认 dry-run，按内容去重，重建向量） |
| `memory_restore` | 恢复一条被墓碑化的记忆（重建索引） |

## 数据与隐私

- 数据文件：`$DSH_HOME/memory/omni.db`（SQLite WAL，单文件，备份即复制；**默认明文落盘，未加密**）
- 所有 HTTP 路由仅绑定 loopback，非本机请求返回 403；写操作只接受 POST，并校验 `Origin` 与 `x-omni-csrf` 头
- 不主动上传任何内容；只有你显式配置 `OMNI_EMBED_URL` 时，文本才会发送到该嵌入端点；`OMNI_SCOPE_JUDGE` 默认 `off`，不会把写入正文发给模型
- persona 自动刷新默认只用离线规则；只有显式 `useModel: true` 或 `OMNI_PERSONA_MODEL=auto/on` 才调用宿主模型，且证据只取全局层，不读取项目内容

## 测试与指标

- 自动化用例：**245 / 245 通过**
- 检索延迟（本机复核，Node 22.23.2；标准 bench 已改为 global scope 并断言真实命中）：10,000 行 p95 ≈ **2.4ms**；100,000 行 ≈ 2.4ms；1,000,000 行 ≈ 6.0ms；1M + 5 万向量 + 100 万 bigram ≈ **116.8ms**（两段式有界检索，见 ADR-020）
- 黄金集（20 语料 / 24 问题）：词面 MRR 0.776 → 混合检索 **0.927**

```bash
npm test
npm run bench          # 延迟基准
npm run bench:golden   # 黄金集
```

## 兼容性

- DeepSeek Harness 0.2.2-rc.3（Desktop，Windows）
- Node 24（使用内置 `node:sqlite`，无原生编译依赖）
- 客户端零依赖：星图为 Canvas 2D 手写投影，不引入 three.js 等库

## 文档

- [设计规格](docs/DESIGN.md)（需求、架构、数据模型、契约、失败模式、追溯矩阵）
- [架构决策记录](docs/ADR)（28 份）
- [威胁模型](docs/THREAT-MODEL.md)（信任边界、残余风险、新增路由检查清单）
- 备份/恢复设计见 [ADR-019](docs/ADR/019-backup-restore.md)
- 1M 行检索改造见 [ADR-020](docs/ADR/020-bounded-retrieval.md)
- 做梦校验的安全边界见 [ADR-021](docs/ADR/021-dream-manual-confirmation.md)
- 进程鉴权与加密的评估结论见 [ADR-022](docs/ADR/022-process-auth-and-encryption.md)
- 多值关系设计见 [ADR-023](docs/ADR/023-multi-valued-relations.md)
- 实体别名与多值画像见 [ADR-024](docs/ADR/024-entity-aliases.md)
- 用户设定见 [ADR-026](docs/ADR/026-persona-settings.md)
- 故障经验库见 [ADR-027](docs/ADR/027-problem-experience.md)
- 多进程并发（多个 AI 客户端共用一个库）见 [ADR-028](docs/ADR/028-multi-process-concurrency.md)
- 远程 embedding 加固与 ANN 边界见 [ADR-025](docs/ADR/025-remote-embedding-and-ann.md)
- [更新日志](docs/CHANGELOG.md)
- [架构图](docs/architecture.png)

## 许可证

**全息记忆个人使用许可 1.1**（仅限个人 · 禁止任何商用）— 不是 OSI 开源许可，源码公开可读。

- ✅ 可以：个人使用、学习、研究、复制、修改、二次开发、借鉴设计，发布你的非商业修改版
- 🚫 不可以：任何形式的商业使用；包括直接商用、修改后商用，以及拿本项目的**源码或架构**去复制、改写、重写、反向工程或做商业替代品、竞品、商业插件、SaaS
- ⚠️ 必须：**署名作者**（保留作者、项目链接、协议声明；修改需注明「已修改」）

最低署名写法（可直接复制）：

```markdown
基于「全息记忆 (Omni Memory)」by wangzhen110
https://github.com/wangzhen110/dsh-omni-memory · 全息记忆个人使用许可 1.1
已修改
```

完整署名规则与更多模板见 [ATTRIBUTION.md](ATTRIBUTION.md)，法律文本见 [LICENSE](LICENSE)。

### 商业授权

需要商业使用（公司内部生产经营、付费服务、SaaS/托管、外包交付、销售/转售/捆绑收费等）时，
请先取得作者书面许可。

**优先渠道（推荐）**：在仓库开 Issue，公开可追踪、回复更快
https://github.com/wangzhen110/dsh-omni-memory/issues

**备用渠道**：64271785@qq.com（标题请注明「商业授权 + 用途」）

作者会在 3 个工作日内回复授权范围与费用。
