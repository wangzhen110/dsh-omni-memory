# ADR-001：存储引擎选 SQLite（`node:sqlite`）

- 日期：2026-11-14
- 状态：已采纳

## 背景

需要单机、零外部依赖、可全文检索、可扩到 10 万行的记忆存储。备选：JSON 文件、LevelDB 类 KV、SQLite、向量库。

## 决策

使用 Node 24 内置的 `node:sqlite`（`DatabaseSync`）：
`journal_mode=WAL`、`synchronous=NORMAL`，数据文件固定在 `$DSH_HOME/memory/omni.db`。

## 理由

1. 零 npm 依赖，符合"插件不可因外部包损坏而崩"的要求。
2. FTS5 与 trigram 分词器可用（本机实测通过），中文子串检索无需额外服务。
3. 单文件便于备份/回滚；WAL 允许读不阻塞写。
4. 与后续向量扩展兼容（`sqlite-vec` 是同族扩展）。

## 代价

- 只能单进程写（本插件本就是单进程）。
- LIKE 查询无法走索引，10 万行后需要为 notes/facts 补 FTS（已登记为 D-03）。
