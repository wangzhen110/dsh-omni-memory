# 全息记忆（Omni memory）

> 给 DeepSeek Harness 的长期记忆内核：**只增不改的原文留底 + 会自我校验的结论 + 按项目分层 + 三路混合召回**。

[![tests](https://img.shields.io/badge/tests-152%2F152-brightgreen)](#测试)
[![license](https://img.shields.io/badge/license-CC%20BY--NC%204.0-lightgrey)](LICENSE)

---

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

- **混合检索**：词面（FTS5 trigram + 中文二元切分）+ 向量（512 维字符 n-gram，可选接真语义嵌入）+ 图游走，RRF 融合排序
- **自动召回**：每轮用你的消息预取 top-3 注入上下文（可关）
- **模型复核归类**：写入先按规则落层，后台让模型复核，判错自动迁移并留痕
- **冲突标记**：显式声明或近重复自动标记 `contested`，只标记不删除
- **做梦校验**：离线拿转录核对笔记，发现"与原文矛盾"时用证据生成替代笔记并保留旧行
- **记忆星图**：整屏旋臂星系，拖拽旋转/滚轮缩放/分层切换；**单击任意星点弹出记忆卡**，搜索命中会亮起脉冲光环
- **隐私**：全部数据在本地 SQLite（`$DSH_HOME/memory/omni.db`），HTTP 只监听 loopback

## 安装

### 插件市场

在 DSH 插件市场搜索「全息记忆 / Omni memory」安装，重启或刷新后左栏出现「全息记忆」入口。

### 本地安装（开发者）

```bash
cd memory-core
npm test          # 147 个用例
npm run check     # 语法与 JSON 校验
```

然后在 DSH 插件管理器中选择本地目录安装。

## 配置

所有开关通过环境变量控制，**修改后需重启 DSH**。

| 变量 | 默认 | 说明 |
|---|---|---|
| `OMNI_AUTO_RECALL` | 开 | `0` 关闭每轮自动召回 |
| `OMNI_SCOPE_JUDGE` | `always` | 模型复核归类：`off` / `auto` / `always` |
| `OMNI_JUDGE_PROVIDER` / `OMNI_JUDGE_MODEL` | 自动 | 指定复核用的模型 |
| `OMNI_EMBED_URL` | 未设置 | 接 OpenAI 兼容 `/embeddings` 启用真语义 |
| `OMNI_EMBED_MODEL` | `text-embedding-3-small` | 远程嵌入模型 |
| `OMNI_EMBED_KEY` | — | 远程嵌入鉴权 |
| `OMNI_EMBED_TIMEOUT_MS` | `10000` | 远程嵌入超时 |
| `OMNI_DREAM_INTERVAL_MS` | `0`（关） | 定时做梦校验 |
| `OMNI_DISABLE_VECTOR` | 未设置 | `1` 关闭向量路线（诊断用） |
| `OMNI_DISABLE_GRAPH` | 未设置 | `1` 关闭图路线 |

## 模型工具

| 工具 | 作用 |
|---|---|
| `memory_write` | 写入笔记 / 事实 / 原始观察 |
| `memory_search` | 混合检索（支持全局 / 项目 / 全部） |
| `memory_profile` | 读取常驻画像 |
| `memory_timeline` | 某实体的时间线（事实 + 相关笔记） |
| `memory_forget` | 墓碑化一条记忆 |
| `memory_dream` | 拿转录核对笔记（默认 dry-run） |
| `memory_compact` | 转录增长治理（默认 dry-run） |

## 数据与隐私

- 数据文件：`$DSH_HOME/memory/omni.db`（SQLite WAL，单文件，备份即复制）
- 所有 HTTP 路由仅绑定 loopback，非本机请求返回 403
- 不主动上传任何内容；只有你显式配置 `OMNI_EMBED_URL` 时，文本才会发送到该嵌入端点

## 测试与指标

- 自动化用例：**147 / 147 通过**
- 检索延迟：10,000 行语料 p95 ≈ **10ms**
- 黄金集（20 语料 / 24 问题）：词面 MRR 0.79 → 混合检索 **0.93**

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
- [架构决策记录](docs/ADR)（13 份）
- [更新日志](docs/CHANGELOG.md)
- [架构图](docs/architecture.png)

## 许可证

**CC BY-NC 4.0**（署名 · 非商业）— 不是 OSI 开源许可，但源码完全公开可用。

- ✅ 可以：个人使用、学习、复制、修改、二次开发、借鉴设计，甚至发布你的修改版
- 🚫 不可以：任何商业用途（含公司内部生产使用、付费服务、SaaS、外包交付、销售/转售/捆绑收费）
- ⚠️ 必须：**署名作者**（保留作者、项目链接、协议声明；修改需注明「已修改」）

最低署名写法（可直接复制）：

```markdown
基于「全息记忆 (Omni Memory)」by wangzhen110
https://github.com/wangzhen110/dsh-omni-memory · CC BY-NC 4.0
已修改
```

完整署名规则与更多模板见 [ATTRIBUTION.md](ATTRIBUTION.md)，法律文本见 [LICENSE](LICENSE)。

### 商业授权

需要商业使用（公司内部生产经营、付费服务、SaaS/托管、外包交付、销售/转售/捆绑收费等）时，
请先取得作者书面许可：

- **邮箱**：64271785@qq.com（标题请注明「商业授权 + 用途」）
- **或在仓库开 Issue**：https://github.com/wangzhen110/dsh-omni-memory/issues

作者会在 3 个工作日内回复授权范围与费用。
