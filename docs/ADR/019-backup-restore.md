# ADR-019：备份、导出与恢复

- 状态：已采纳
- 日期：2026-11-17
- 关联：ADR-002（不硬删除）、ADR-017、v2.3.3 路线第 1 项

## 背景

记忆库是单文件 SQLite，理论上"复制 `omni.db` 即备份"。实际使用中有三个缺口：

1. 用户无法在界面内拿到一份可读、可迁移的备份；
2. 被 `memory_compact` / `memory_forget` 墓碑化的行虽然保留，但产品层没有恢复入口（"审计可见、活跃不可回"）；
3. 跨机器/跨库迁移没有受支持的格式，只能整库拷贝，schema 版本一变更就不可用。

## 决策

### 1. 导出格式：可读 JSON 快照

```json
{
  "format": "omni-memory-backup",
  "version": 1,
  "exportedAt": 0,
  "schema": 11,
  "source": "omni.db",
  "counts": { "notes": 0, "facts": 0, "chunks": 0, "edges": 0, "entities": 0, "relations": 0, "entityAliases": 0, "persona": 0 },
  "notes": [], "facts": [], "chunks": [], "edges": [], "entities": [], "relations": [], "entityAliases": [], "persona": []
}
```

- **包含墓碑与历史**（默认）：恢复才有意义；`activeOnly` 供体积敏感场景，只导出活跃笔记和未失效事实。
- **不包含向量**：向量是派生索引，与后端/维度耦合；导入后重建，避免把某一后端的向量带进另一后端。
- 必须携带 `relations / entity_aliases / persona`，否则导入会丢失多值关系的 cardinality、实体别名和用户设定。
- 每行保留原始 `ts / valid_from / valid_to / recorded_at / deleted_at / superseded_by / verification / evidence`，恢复后审计链不断；v11 起 note 还保留 `problem_key / solution_status / solution_verified_at / reuse_count / last_used_at`。

### 2. 导入：按内容去重、默认 dry-run

- 默认 `dryRun: true`，只报告将导入多少行；写库必须显式 `dryRun: false`。
- 去重键：note `(scope, text)`、fact `(subject, relation, object, scope)`、chunk `(hash, scope)`、edge `(src, rel, dst, scope)`。
- `relations` 的 `cardinality`、`entity_aliases`、`persona` 一并 upsert；旧备份里的 `aliases` 字段仍然兼容。
- id 不保证保留：新库可能已有同 id 行。note 的 `superseded_by` 在导入后按 id 映射重写；其它表没有跨行 id 引用。
- 导入在一个 `BEGIN IMMEDIATE` 事务内完成；失败整体回滚。
- 导入后重建 FTS / bigram / 向量（远程后端进入待嵌入队列）；v11 的故障经验字段原样恢复，不重新推断状态。

### 3. 恢复：只复活，不猜语义

- `memory_restore(kind, id)` 仅清除 `deleted_at`，并重建该行的派生索引。
- 不自动恢复"被替代"的旧结论（那是语义判断，应通过审计视图人工决定，或重新写入）。
- 事实恢复时，如果对应的 active edge 不存在则补建；否则保留现状。
- chunk 恢复前检查同 `hash/scope` 是否已有活跃行；如果有，返回 `{restored:false, reason:'active duplicate', activeId}`，不再用唯一索引撞库。
- 恢复只由 POST + `x-omni-csrf` + 同源校验触发；路由用 400 返回结构化失败原因。

### 4. 界面

- 顶部工具条新增「导出」（浏览器下载 JSON）与「审计」开关。
- 审计视图展示被替代 / 已删除 / 失效行；删除行显示「恢复」按钮，替代行显示标注但不提供自动反替代。
- 分页在审计视图固定取最近 200 行，避免与活跃计数混用。

## 安全边界

| 面 | 说明 |
|---|---|
| 导出 | 返回**全量记忆**（含原文）；仅 loopback 可访问，不提供跨机网络入口 |
| 导入 | 只接受本地文件路径（工具参数），不做 HTTP 上传，避免请求体与任意文件读取面 |
| 恢复 | 写操作，POST + CSRF + 同源 |
| 文件位置 | 默认写入 `$DSH_HOME/memory/`，与数据库同目录；文件名带时间戳 |

## 残余风险

1. 导出文件是明文 JSON，复制扩散后无法追踪（与数据库明文同属一个边界，见 THREAT-MODEL）。
2. 导入不校验来源，恶意备份可以注入任意记忆内容（等价于直接改库）；这是本地信任边界内的已知风险。
3. 大库导出在请求线程内序列化，10 万行级别可能占用数秒内存；后续可改为流式写文件。
4. 向量重建对远程后端是异步队列：导入后立即可做词面检索，语义召回要等 flush。

## 验证

- `test/backup.test.mjs` 7 例：导出含墓碑、activeOnly、导出路由附件头、导入 dry-run、二次导入去重、lineage id 重映射、restore 生效、restore 路由 CSRF、审计列表可见墓碑。
- `test/review-fixes-3.1.3.test.mjs` 覆盖 activeOnly 排除 superseded/expired、relations/cardinality/aliases/persona 导入、chunk restore 冲突。
- 全量 235 / 235。
