# ADR-024：实体别名与多值画像

- 状态：已采纳（v2.9.0）
- 日期：2026-11-17
- 关联：ADR-023（多值关系）

## 背景

ADR-023 落地了关系基数，但还有两个缺口：

1. **同一实体多种写法**：`Deploy` / `deploy` / `上线` 在图上是不同节点，时间线和检索各看一半；
2. **画像只有笔记**：多值关系已经能存多个 active 值，但注入给模型的画像里看不到事实。

## 决策

### 1. 写入时规范化 + 别名注册表

- 事实的 **subject** 在写入前经过 `normalizeEntity`：
  - 去首尾空白、压缩内部空白；
  - 全角 ASCII 转半角；
  - 转小写（中文不受影响）；
  - 去掉首尾引号与句末标点。
- 再沿 `entity_aliases(alias → canonical)` 链解析到规范名（最多 5 层，防环）。
- object 不做规范化：它经常是值（路径、数字、专有名词），改写会破坏原意。
- 新工具 `memory_link_entity({ alias, canonical, apply })`：
  - 默认 dry-run，报告会迁移多少 facts / edges；
  - `apply: true` 时写别名、把 `facts.subject` 与 `edges.src` 改写为 canonical、删除旧 entities 行；
  - 之后的写入通过别名自动落到 canonical。

### 2. 时间线

`memory_timeline` 的 entity 参数先走 `canonicalEntity`；subject 用规范名精确匹配，object 同时匹配原始写法与规范名（object 未规范化）。

### 3. 画像事实块

- `buildProfileText`（注入）与 `memory_profile`（工具）共用 `profileFactLines`：
  - 只取 active facts（`valid_to IS NULL`）；
  - 按 `subject·relation` 分组，每组最多 3 个值，因此多值关系显示 `咖啡 / 茶` 而不是最新一个；
  - 与笔记共用 1200 字预算，超出即截断；
  - scope 语义与笔记一致：全局 + 本项目。

## 结果

- Schema v9：`entity_aliases(alias PK, canonical, updated_at)` + canonical 索引。
- 测试：`test/entity-alias.test.mjs` 4 例（规范化、dry-run、合并 facts/edges/时间线、多值画像）。
- 老库升级：v8→v9 只建表，不改写行。

## 残余风险

1. 规范化会合并大小写不同的专有名词（`iPhone` → `iphone`）；如需保留大小写，需要实体级开关，目前没有。
2. 别名链没有环检测之外的冲突处理（A→B 同时 B→A 会被链解析停下，但注册表仍可写入）。
3. 合并只改 facts/edges，不改笔记正文；笔记里的旧写法仍按原文检索。
4. 画像事实块按 confidence/时间取前 40 条，超出的关系不出现在注入里。

## 未来

- 别名自动发现（从同一段转录中抽取共现实体），需要模型或规则评估；
- 大小写敏感开关；
- 实体合并的撤销（当前只能手工 link 回去）。
