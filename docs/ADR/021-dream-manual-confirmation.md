# ADR-021：dream 默认只标记，替代需人工确认且可回滚

- 状态：已采纳
- 日期：2026-11-17
- 关联：ADR-010（做梦校验）、ADR-017、路线第 3 项

## 背景

v2.5.0 及之前，`memory_dream({ apply: true })` 会对 `unsupported` / `contradicted` 的笔记**自动**做两件事：

1. 标记 `contested = 1`；
2. 用证据文本生成一条新笔记，并让旧笔记 `superseded_by` 指向它。

标记是安全的；**自动替代是语义决策**，而 dream 的判定是确定性的词面覆盖度 + 特征词缺失，不是语义理解。评审指出的风险成立：覆盖度低不等于结论错，证据摘录也不等于正确的替代结论。用户没有任何确认或回滚入口，只能从审计视图看到旧行（且没有"反替代"操作）。

## 决策

### 1. 默认只标记

- `memory_dream({ apply: true })`：写 `verification / verified_at / evidence`，对 `unsupported` / `contradicted` 置 `contested = 1`，并在 actions 中返回 `proposedText`（证据摘录），**不创建替代笔记、不设置 `superseded_by`**。
- 批量替代必须显式 `commit: true`（`apply: true, commit: true`），文档标注为"批量危险操作"。

### 2. 单条替代需要确认

- 新工具 `memory_dream_proposals`：列出已标记笔记及其证据摘录（只读）。
- 新工具 `memory_dream_replace({ noteId, confirm: true })`：单条替代；`confirm !== true` 直接报错。
- 替代笔记 `source = dream:<旧 id>`，`revision = 旧 revision + 1`，旧笔记保留（`superseded_by` 指向新行）。
- HTTP 对应 `POST /omni-memory/dream/replace`（POST + CSRF + 同源）。

### 3. 可回滚

- 新工具 `memory_dream_rollback({ noteId })`：仅当当前替代行的 `source` 以 `dream:` 开头时生效：
  - 旧笔记 `superseded_by = NULL`、`contested = 0`（重新进入活跃集合）；
  - 生成的替代笔记墓碑化（`deleted_at`），不再出现在任何活跃读取路径；
  - 重建/保留索引不变（旧行索引本来就在）。
- 非 dream 产生的替代（人工或导入）拒绝回滚，返回 `{ restored: false, reason: 'not a dream replacement' }`。
- HTTP 对应 `POST /omni-memory/dream/rollback`。

### 4. 界面

- 审计视图里被替代的行显示「反替代」按钮（POST rollback）；删除行仍显示「恢复」。
- 替代候选列表暂通过工具/HTTP 查看，面板不新增独立页签（避免把确认流程藏进 UI 深处；先保证能力可用）。

## 结果

- 187 / 187 测试（新增 6 条 dream 安全用例：默认不替代、commit 才替代、proposals、confirm 校验、回滚复活、拒绝非 dream 替代）。
- 旧行为变为显式：现有使用 `apply: true` 的用户会发现"只标记不替代"，这是有意的破坏性变更，CHANGELOG 已标注。

## 残余风险

1. `contested = 1` 会立即把笔记移出画像与自动召回；误判仍有可见影响（但不再是"结论被替换"）。
2. dream 判定仍是词面启发式，proposals 里的 `proposedText` 只是证据摘录，不保证是正确结论；确认者需要自己读一眼。
3. 回滚后旧笔记重新活跃，但 `verification` 仍保留 `contradicted`，审计可见；再次 dream 会重新标记。
4. 批量 `commit: true` 没有分页确认，一次可能替代多条；建议默认走单条 replace。

## 验证

- `test/dream-safety.test.mjs` 6 例；`test/dream.test.mjs` 的替代用例改为显式 `commit: true`。
- 真机 API：proposals 只读；replace/rollback GET → 405、无 CSRF → 403。
