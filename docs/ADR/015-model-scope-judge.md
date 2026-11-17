# ADR-015：模型复核归类（规则兜底，模型纠偏）

- 日期：2026-11-14
- 状态：已采纳

## 背景

ADR-014 的归属判断靠措辞规则，快但关键词盲：**说法稍微绕一下就会判错**。用户要求"让 AI 自动归类"。

宿主暴露了 `llm` 服务（`listProviders / listModels / stream`），插件可以直接发起一次小模型调用。

## 决策

### 三段式：先落层，再复核，错了再改

1. **写入不等待**：按规则立即判定并落库，工具调用保持毫秒级返回。
2. **后台复核**：把写入项放进队列，用 `llm.stream` 发一条极短请求（`maxTokens: 8`、`temperature: 0`、4 秒超时），让模型只回答 `global` 或 `project`。
3. **判错即迁移**：模型答案与当前层不同时，`UPDATE ... SET scope = ?`，同时清空画像缓存并在 `/omni-memory/status` 的 `lastJudge` 里留痕（from → to、模型名、时间）。

### 何时复核

| `OMNI_SCOPE_JUDGE` | 行为 |
|---|---|
| `off`（默认） | 从不调用模型 |
| `auto` | 只复核规则**没把握**的项（confidence < 0.8），即 `default-to-project` |
| `always` | 除下面两种豁免外，每条都复核 |

两条豁免即使 `always` 也不调用模型：

1. **显式 scope**：调用方已经决定，模型不得推翻；
2. **没有项目上下文**：此时唯一可能的层是 `global`，没有可判断的分歧。

### 用哪个模型

- `OMNI_JUDGE_PROVIDER` / `OMNI_JUDGE_MODEL` 显式指定；
- 否则取第一个已注册 provider，再挑 id 里带 `flash / mini / haiku / small / lite` 的模型，最后退回该 provider 的第一个模型。

### 失败如何降级

模型不可用、超时、返回空、抛错——**一律保留规则判定**，写入本身早已成功。复核是增强，不是依赖。

## 代价

- `auto` 模式下每次含糊写入多一次模型调用（约几百分之一元的量级，取决于模型）。
- 归属可能在写入后几秒内"跳一次"（在面板可见，`lastJudge` 可查）。
- 模型判定并非绝对正确；规则与模型都错时，仍可在面板里人工改。

## 验证

`test/scope-model-judge.test.mjs`（9 例，使用假 `llm` 服务）：含糊项被改判、`auto` 不碰高置信项、`always` 全量复核、`off` 不调用、模型抛错保留规则、无 llm 服务照常写入、状态接口暴露 `lastJudge`、显式 scope 不被推翻、无项目时不调用模型。

## 默认值与成本（定稿）

- 默认 `off`（见 DESIGN §14）：默认离线，不把笔记正文发给外部模型；需要更准时显式打开 `auto` / `always`。
- 成本：显式开启后每条复核约 100 输入 token + 8 输出 token，用 `deepseek-flash` 量级模型。
- 回退：`auto`（只复核规则没把握的）/ `off`（完全离线）。
- 线上事实记录：2026-11-14 真机 `note #12` 由规则判 `project`，被 `deepseek-official/deepseek-flash` 改判为 `global`，`lastJudge` 可查；该实验是显式开启 `always` 时做的，不是默认行为。
