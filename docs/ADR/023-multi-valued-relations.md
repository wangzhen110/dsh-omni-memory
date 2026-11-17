# ADR-023：多值关系与实体消歧（设计提案，未实施）

- 状态：已实施（v2.8.0；实体消歧仍未实施）
- 日期：2026-11-17
- 关联：ADR-003（facts 时间语义）、路线第 7 项

## 实施记录（v2.8.0）

已按提案落地第一层（关系基数），未做实体消歧：

- Schema v8：`facts.cardinality`（默认 `single`）+ `relations(name, cardinality, aliases, updated_at)`；
- `memory_write({ kind: 'fact', cardinality: 'multi' })`：显式声明后写入关系注册表，同 `subject+relation` 的其它值**不再过期**；
- 未显式声明时沿用注册表里的基数（默认 `single`），老库全部按 `single` 迁移，行为不变；
- 多值下重复写入同一 object 视为同一条事实（`deduped: true`），不产生重复行；
- scope 隔离不变：项目层 multi 不会过期全局 single，反之亦然；
- 测试：`test/multi-value.test.mjs` 4 例（单值过期、多值并存、重复去重、跨层隔离）+ `test/migration-v8.test.mjs` 2 例（v7→v8、版本标记已为 8 但缺列的修复路径）。

实体消歧、别名合并、多值画像 top-N 仍按本 ADR 的"未实施"部分保留。

## 背景

当前 `facts` 的语义是"一个 subject + relation 只有一个当前 object"：

- 写入同一 `(subject, relation)` 的新值时，旧值会被标记 `valid_to`（时间失效）；
- 因此"我喜欢咖啡"之后再写"我喜欢茶"，咖啡会被判为过期，而不是两条并存；
- 实体没有消歧：`部署`、`deploy`、`上线` 是不同 subject，图上是不同节点。

这对"偏好、成员、标签"这类天然多值的关系是错的；对"当前部署版本、所在地"这类单值关系是对的。评审把它列为未解项，路线标注为"独立立项"。

## 提案（不改现有表结构，新增两列 + 一张注册表）

### 1. 关系基数

```sql
ALTER TABLE facts ADD COLUMN cardinality TEXT NOT NULL DEFAULT 'single'; -- single | multi
CREATE TABLE IF NOT EXISTS relations (
  name TEXT PRIMARY KEY,
  cardinality TEXT NOT NULL DEFAULT 'single',
  aliases TEXT,           -- JSON array, for entity/relation canonicalisation
  updated_at INTEGER
);
```

写入时查 `relations.cardinality`（缺省 `single`）：

- `single`：保持现状，新值让旧值 `valid_to`；
- `multi`：不失效旧值，允许多个 active object；同一 object 重复写入只更新 `recorded_at`。

迁移：老行默认 `single`，行为不变；用户/工具可显式声明某关系为 `multi`。

### 2. 查询与画像

- 检索：多值关系全部返回（`valid_to IS NULL` 已覆盖）；
- 画像：按"主体 + 关系"聚合，单值显示最新，多值显示 top-N（按置信度/时间）；
- 图：多值关系产生多条边，天然正确。

### 3. 实体消歧（更晚）

- `entities` 增加 `canonical_id`、`aliases`；写入时用规则（大小写、全半角、常见别名表）合并；
- 真正的语义消歧需要模型调用，默认 off，与 `OMNI_SCOPE_JUDGE` 同样受隐私开关控制；
- 不在本次范围：需要标注集评估，且会改变图的连通性。

## 为什么现在不做

1. 需要迁移与回填（`facts` 加列、关系注册表、老数据默认值），属于数据模型变更；
2. 写入路径（`memory_write` 的事实合并逻辑）目前只有一处，改动可控，但需要决定"未声明关系"的默认值，否则会静默改变现有行为；
3. 实体消歧缺少评估集，做了也无法证明"更好"；
4. 与 1M 性能改造、dream 安全化、备份恢复相比，多值关系的用户可见收益更窄（偏好类记忆才需要）。

## 实施前置条件

- 有至少一组真实"多值偏好"用例作为验收；
- 明确默认基数策略（建议：未声明 = single，保持兼容）；
- 写入时允许工具参数显式 `cardinality: 'multi'`，并记录到 `relations`；
- 迁移测试覆盖：老库升级、单值→多值切换、回滚。
