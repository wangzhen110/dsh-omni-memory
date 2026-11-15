# ADR-010：做梦校验用确定性覆盖度 + 关键词缺失，不调用模型

- 日期：2026-11-14
- 状态：已采纳

## 背景

FR-20 要求「离线任务拿原文核对笔记，发现错误时修订并留痕」。Anthropic 的 dreaming 实践确实用模型做这一步，但本插件是宿主内的后台组件：

- 每条笔记一次模型调用，成本与延迟都不可控；
- 宿主插件的模型通道并非稳定契约，升级易碎（mnemon 的教训）；
- 后台任务一旦失败，不能影响会话。

## 决策

用确定性的两步判定，不调用模型：

1. **找证据**：优先按 `notes.source` 精确匹配 `chunks.source`；没有来源时，在最近 300 条转录里找 token 命中率最高的那条（≥0.4 才算找到）。
2. **判支持度**：`coverage = 笔记 token 在证据文本中出现的比例`。
3. **判矛盾**：覆盖度 ≥0.6 且笔记中存在**证据里没有的拉丁/数字特征词**（如 `docker`）→ `contradicted`。理由：换值类错误只占极少 token，覆盖度看不出来，而这类词是可确定检测的锚点。

判定结果：

| 判定 | 条件 | 动作（apply=true） |
|---|---|---|
| `supported` | coverage ≥ 0.8 | 记录 `verification` / `evidence` / `verified_at` |
| `weak` | 0.4 ≤ coverage < 0.8 | 记录，等待人工复核 |
| `contradicted` | coverage ≥ 0.6 且有缺失特征词 | 标 `contested=1`，用**证据原文**生成替代笔记（`source: dream:<id>`、`revision+1`），旧笔记写 `superseded_by` |
| `unsupported` | coverage < 0.4 | 同 `contradicted` |
| `no_source` | 找不到证据 | 仅记录，不改动 |

## 为什么保留旧笔记

修订不是覆盖：旧行保留，`superseded_by` 指向替代笔记，`contested=1` 在界面可见。人可以回溯"当时为什么这么记"，也能一键遗忘。

## 验证

`test/dream.test.mjs`（5 个用例）：

- 正确笔记 → `supported`；
- 笔记写 Docker、转录说裸机 → `contradicted`，`missingTokens=['docker']`，替代笔记文本来自转录；
- 无来源 → `no_source`；
- 已替代的笔记不会被二次校验；
- 每条判定都写入 `evidence` 与 `verified_at`。

## 代价与局限

- 只能发现"换值/缺失证据"类型的错误，无法判断语义级别的细微矛盾（那需要模型）。
- 替代笔记来自证据原文，可能较长（截断 600 字），重要性固定 0.5。
- 扫描上限 100 条笔记 × 300 条转录，属于离线任务，不进入检索热路径。
