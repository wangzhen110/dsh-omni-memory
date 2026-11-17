# ADR-012：自动召回用「事件预取 + 装配同步读缓存」，状态小尾巴读同一份统计

- 日期：2026-11-14
- 状态：已采纳

## 背景

要开 `OMNI_AUTO_RECALL`：每次装配前用**当前用户消息**检索 top-3 拼进提示，并在对话结尾显示一行状态证明它生效。

两个约束：

1. `PromptSection.text` 是**同步**执行，且 `AssembleContext` 只有 `scope`/`signal`——拿不到用户消息，也不能 await 检索。
2. 检索本身是异步的（向量路线可能要 flush 远程嵌入队列）。

## 决策

### 自动召回：三段式

1. **捕获**：监听 `agent/inbox/claimed`（emit，非阻塞），取出用户消息文本，按 `agent.id` 记到内存 Map。
2. **预取**：同一事件里 `void precomputeRecall(agentId, text)` 异步跑一次 `runSearch(..., 3)`，结果按 agent 缓存（TTL 120 秒）。
3. **同步读**：`PromptSection.text(context)` 用 `context.scope.id` 取缓存，命中则追加：

```
Recalled for this request (ranked by the same hybrid search; verify before acting on it):
- [note#3] …
```

缓存未命中（竞态）时**只注入画像**，不重试、不阻塞、不报错。

### 开关

`OMNI_AUTO_RECALL=0` 关闭；未设置即开启。默认开启是因为用户明确要求"它能自动起作用"。

### 小尾巴：读同一份统计

- 每次装配都会更新 `lastInjection = { at, chars, recall, auto }`。
- 新增 `GET /omni-memory/status` 返回 `lastInjection` 与存储统计。
- 客户端在 `conversation.composer.dock`（id `memory-tail`，order 3）渲染一行：
  `● 记忆 · 注入 812 字 · 召回 3 · 共 7 条`，5 秒轮询；60 秒内有注入时圆点变绿。

## 为什么小尾巴不做成"改写助手回复"

改写模型输出需要拦截消息流，属于聊天渲染层，违反 CON-02（不碰聊天流）。composer 下方的 dock 本来就是"环境信息条"的座位，语义正确且零风险。

## 代价

- 每次用户消息多一次本地检索（p95 约 10ms，10k 行），可忽略；远程嵌入后端下会多一次批量 flush。
- 每个 agent 缓存一条 recall，长会话内存占用极小；TTL 到期自动失效。
- 竞态时当轮没有召回（画像仍在），下一轮就会命中。

## 验证

`test/autorecall.test.mjs`（5 个用例）：开关开启时召回出现在提示段；`OMNI_AUTO_RECALL=0` 时不出现；`/omni-memory/status` 返回注入统计；状态路由仅 loopback；未收到消息时降级为仅画像。
