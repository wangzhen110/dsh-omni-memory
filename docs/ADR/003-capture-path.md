# ADR-003：捕获只订阅 `session/event` 的提交后事件流

- 日期：2026-11-14
- 状态：已采纳

## 背景

需要自动把对话写入转录层，且不得干扰正在显示的会话。此前事故：对在线会话调用 `sessionQuery.inspectSession` 会 prepare 会话、顶掉实时投影，聊天区变空白，刷新不可恢复。

## 决策

只监听 `session/event`（mode: emit，提交后、fire-and-forget），处理 `user/message` 与 `assistant/message` 两类事件，同步写入 chunks。

明确禁止：读取会话投影、调用 `inspectSession`、等待网络、抛错。

## 理由

- 事件流是权威的"已提交"信号，天然不去碰投影。
- 失败被 try/catch 吞掉，满足 NFR-07（记忆失败不影响会话）。

## 代价

- 拿不到未提交的流式增量（也不需要）。
- 工具调用与工具结果暂不捕获（D-12）。
