# ADR-027：故障经验库（问题指纹 / 解法状态 / 复用反馈）

- 状态：已采纳（v3.2.0）
- 日期：2026-11-18
- 关联：ADR-005（检索打分）、ADR-013（scope 分层）、ADR-019（备份恢复）、ADR-020（有界检索）

## 背景

全息记忆原本是通用长期记忆：笔记、事实、转录三层，加混合召回。它适合存"用户说过什么、项目是什么"，但不适合回答 AI 工作时最常遇到的一类问题：

> 我刚才遇到过同样的报错吗？上一次到底怎么解决的？那个解法真的有效，还是一条死路？

通用笔记缺少三样东西：

1. **稳定的问题指纹**：同一错误在不同会话里措辞不同，仅靠全文相似度会漏；
2. **真实结果状态**：`verification` 记录的是"转录是否支持这条笔记"，不是"这个修复在现实中是否成功"；
3. **复用反馈**：一个解法被再次使用后，没有任何计数或可信度变化。

因此需要在不另起大表的前提下，把 notes 扩展成"问题—尝试—解法—验证—适用条件"的载体。

## 决策

### 1. Schema v11：notes 增加经验字段

```sql
ALTER TABLE notes ADD COLUMN problem_key TEXT;
ALTER TABLE notes ADD COLUMN solution_status TEXT;
ALTER TABLE notes ADD COLUMN solution_verified_at INTEGER;
ALTER TABLE notes ADD COLUMN reuse_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN last_used_at INTEGER;
CREATE INDEX notes_problem_key ON notes(problem_key);
CREATE INDEX notes_solution_status ON notes(solution_status);
```

- `problem_key`：问题指纹。写入时去首尾、压缩空白、转小写、限长 200 字符；精确匹配，不做模糊扩展。
- `solution_status`：`verified / unverified / failed / expired`；读取时 NULL 视为 `unverified`。
- `solution_verified_at`：**独立字段**，不覆盖 dream 使用的 `verified_at`。两者语义不同：
  - `verification`：`memory_dream` 判断"转录是否支持这条笔记"；
  - `solution_status`：现实世界"这个解法是否解决了问题"。
- `reuse_count / last_used_at`：真实复用次数与最近使用时间。
- 旧库由 v11 迁移补齐；旧行保持 NULL，不会被强行标记为已验证。

### 2. 写入

`memory_write(kind='note')` 新增可选参数：

- `problemKey`：错误签名、失败命令、关键堆栈的归一化文本；
- `solutionStatus`：本次写入时已知的现实结果；
- `evidence`：命令输出、测试结果、URL 或简短验证说明。

同一 `(scope, text)` 重复写入仍返回旧 id，但允许用本次参数补写 `problem_key / solution_status / solution_verified_at / evidence`，避免已有经验无法加标记。

`problemKey / solutionStatus / evidence` 只允许 note；fact/episode 传入会报错。

### 3. 检索

`memory_search` 的变化：

- `query` 改为可选；`query` 与 `problemKey` 至少有一个；
- 新增 `problemKey`：先走精确 SQL，命中带 `exactProblem: true` 并置顶；
- 新增 `status`：`all / verified / unverified / failed / expired`；指定具体状态时只返回 notes，facts/chunks 不混入；
- 新增 `kind`：`all / note / fact / chunk`；
- 命中项返回 `problemKey / solutionStatus / reuseCount / lastUsedAt / verifiedAt / verification / evidence`。

排序：

- 文本/权重/时效分照旧；
- notes 额外加经验状态分：verified `+0.2`、failed `-0.2`、expired `-0.35`，复用次数按 `log1p` 最多 `+0.15`；
- 因为 RRF 会覆盖单路分数，状态分在融合后的最终排序阶段再叠加一次，保证 verified 不会被词面排名压掉；
- 精确 `problemKey` 命中额外 `+0.5` 并置顶。

### 4. 复用反馈

新增工具 `memory_solution_report({ id, outcome, evidence? })`：

- `success`：`solution_status='verified'`、`solution_verified_at=now`、`reuse_count += 1`、更新 `last_used_at`；
- `failed`：`solution_status='failed'`、清空 `solution_verified_at`、`reuse_count += 1`；
- `expired`：`solution_status='expired'`、清空 `solution_verified_at`、`reuse_count += 1`；
- 只接受活跃（未墓碑、未被替代）笔记；
- 每次调用都代表一次真实使用，所以 failed/expired 也累计次数。

### 5. 备份与导入

- 备份 schema 从 10 升到 11；
- `snapshotStore` 的 notes 使用 `SELECT *`，自动携带新字段；
- `mergeSnapshot` 的 notes INSERT 显式补列，并同时接受 snake_case 与 camelCase 备份字段；
- 导入后重建 FTS/bigram/vector，保留 `problem_key / solution_status / solution_verified_at / reuse_count / last_used_at`。

## 不做的事

- 不新建 `problems` / `solutions` 大表：当前关系是"一条笔记就是一个经验"，独立表会带来跨表一致性和迁移成本；
- 不把 `verification` 和 `solution_status` 合成一个字段：两者语义不同，合并会破坏 dream 的既有契约；
- 不自动调用外部搜索：项目只提供检索与沉淀能力，是否上网由调用方决定；
- 不把经验写进常驻 prompt：预算只有 1200 字，且空库测试要求 section 为空；"遇障碍先检索"写进工具描述和 README，靠调用方遵守；
- 不做问题指纹的模糊匹配：先用精确签名保证可重复，再靠普通混合检索兜底；语义级归并留给后续模型复核。

## 残余风险

1. `problem_key` 是调用方约定的字符串，命名不统一会降低命中率；需要在使用中形成稳定的错误签名规范。
2. `reuse_count` 只统计显式 `memory_solution_report`，不统计普通 `memory_search` 命中；沉默复用不会自动加分。
3. 同一个问题可能有多条笔记；当前不自动合并，只靠 `contested` / `superseded` 和状态排序治理。
4. 精确指纹命中置顶可能压过更通用的高价值笔记；用 `kind/status/limit` 和查询词约束可缓解。
5. 旧库笔记没有 `problem_key`，只能走普通检索；需要时由调用方补写。

## 验证

- `test/solution-memory.test.mjs` 10 例：指纹归一化、verified 优先、status/kind 过滤、复用反馈、去重补写、备份导入、note-only 校验、列表字段、失败经验不进入常驻画像；
- 既有 schema / backup / tools 断言同步到 v11、235 用例、17 工具；
- `npm test` 235/235 通过；`npm run check` 文档门禁通过。
