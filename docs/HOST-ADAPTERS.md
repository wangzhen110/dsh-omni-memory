# 宿主适配层：MCP 之外的接入方式

MCP 定义的是“工具/资源/提示如何暴露”，不是“会话开始时自动注入记忆”。因此要把全息记忆接到不同 AI 工具，必须按宿主能力分层，而不是要求每个客户端都支持同一种注入方式。

## 四种宿主能力

- **A. DSH 原生插件**  
  有系统提示注入点，画像和自动召回直接进入每轮上下文，能力最完整。
- **B. 支持本地 MCP 的开发者工具**  
  例如 Claude Desktop / Claude Code、Cursor、Cline、Continue、Zed、Windsurf 等。工具能看见，但自动行为仍要靠项目规则、自定义指令或 SessionStart / UserPromptSubmit hook。
- **C. 支持 OpenAPI / function calling，但不认 MCP**  
  通过 `GET /omni-memory/openapi.json` 导入接口，用 `POST /omni-memory/tool` 调用受限工具面。
- **D. 只能聊天的闭源入口**  
  没有任意本地 MCP、没有工具调用、没有系统提示注入点。只能做预检索 sidecar：先取 `/packet`，再由用户、浏览器扩展或剪贴板工具把文本放到对话开头。MCP 服务端本身无法替这类宿主注入。

## 本项目提供的通道

### 1. MCP（A/B 类宿主）

```bash
node hosts/mcp/bin.mjs
```

支持 stdio 与 HTTP `POST /mcp`。`initialize.instructions`、`omni-bootstrap` prompt、`memory_rules` 工具、`omni://rules` 资源都返回同一份规则文本。

### 2. CLI context（hook / sidecar）

```bash
node hosts/cli.mjs context --query "当前任务"
node hosts/cli.mjs context --stdin        # Claude Code hook 等从 stdin 读 prompt
```

输出就是可直接拼接的画像 + 相关记忆文本。适合 SessionStart / UserPromptSubmit hook。

### 3. HTTP packet（无 MCP 宿主）

```bash
# JSON：包含 text、memories、字符数和截断标记
curl "http://127.0.0.1:7788/omni-memory/packet?q=部署端口"

# 纯文本：直接复制到对话开头
curl "http://127.0.0.1:7788/omni-memory/packet?q=部署端口&format=text"

# 按项目层取，避免跨项目串味；cwd 可从工作目录推导项目键
curl "http://127.0.0.1:7788/omni-memory/packet?cwd=D:\\xiangmu\\全息记忆&q=星图"

# 显式跨项目审计
curl "http://127.0.0.1:7788/omni-memory/packet?scope=all&q=星图"
```

`budget` 默认 1800 字符，范围 400..4000；`limit` 默认 5，最大 10。只读，不需要 CSRF 头，但仍只接受本机回环请求。

### 4. OpenAPI / tool bridge（C 类宿主）

```bash
curl http://127.0.0.1:7788/omni-memory/openapi.json
```

工具桥只暴露核心读写工具：`memory_write`、`memory_search`、`memory_solution_report`、`memory_feedback`、`memory_get`、`memory_amend`、`memory_profile`、`memory_timeline`。导出、导入、compact、reindex、dream、persona 等维护面仍留在 MCP/CLI。

```bash
curl -X POST http://127.0.0.1:7788/omni-memory/tool \
  -H "content-type: application/json" \
  -H "x-omni-csrf: 1" \
  -d '{"name":"memory_search","arguments":{"query":"部署端口","scope":"all"}}'
```

## 安全边界

- 所有 HTTP 路由只监听 loopback；非本机请求返回 403。
- `/tool` 是写操作，必须带 `x-omni-csrf: 1`，并校验 Origin；跨站表单无法伪造该头。
- 跨项目读取/改写需要显式 `scope=all`；默认只走当前项目 + global。
- 不要把 `--bind 0.0.0.0` 暴露到公网；如果必须远程，前面加 TLS、认证和网络 ACL，且不要把未鉴权的 `/mcp` 或 `/tool` 直接开放。
- 不建议用桌面 UI 自动化硬注入豆包等闭源聊天端；接口不稳定，也可能违反平台条款。可靠的降级路径是 `/packet` + 人工/扩展粘贴。

## 一句话选择

有 DSH：用原生插件。  
有 MCP：接 stdio/HTTP MCP，再补规则或 hook。  
只有 OpenAPI：用 `openapi.json` + `/tool`。  
只能聊天：用 `/packet` / `omni context` 做预检索 sidecar。  
