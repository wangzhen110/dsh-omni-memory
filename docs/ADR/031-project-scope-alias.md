# ADR-031：跨平台项目键大小写归一与旧 scope 迁移

日期：2026-11-21 · 状态：已接受 · 版本：3.9.4

## 背景

`projectKeyFromCwd` 用绝对路径的 FNV-1a 哈希生成 `proj:<basename>#<hash>`。3.9.3 及以前没有做平台大小写归一：Windows 和 macOS 默认路径大小写不敏感，`D:\Repo` 与 `d:\repo` 会得到不同项目键；同一工作区用不同大小写打开后，旧笔记落在旧键、新笔记落在新键，检索默认只看当前键，表现成“记忆静默丢失”。

历史旧键无法从 6 位哈希反推原始路径，不能按 basename 猜测合并，否则同名不同盘的项目会被误合并。

## 决策

1. 路径键归一：Windows（`win32`）与 macOS（`darwin`）在生成哈希前把规范化路径转小写；Linux 保留大小写，因为其路径区分大小写。`projectKeyFromCwd(cwd, platform)` 接受平台参数，测试可显式覆盖。
2. 保留 `legacyProjectKeyFromCwd(cwd)` 的旧算法，只用于识别和迁移旧键，不用于新数据。
3. schema v15 新增 `scope_aliases(alias PRIMARY KEY, canonical, created_at)` 与 canonical 索引。旧键 → 新键的映射持久化，迁移可重复执行。
4. `ensureProjectAlias(db, cwd)` 在 `openStore(process.cwd())`、`attachSession` 与 `scopeForSession` 调用：
   - 只自动迁移**能由当前路径直接推导**的旧键，或由 `project_path:<canonical>` 中保存的完整旧路径匹配到的键；
   - 不按 basename 猜测，不自动合并未知项目；
   - 若旧键没有数据，只写 alias，防止以后导入时再次分裂。
5. `migrateScopeAlias` 在一个 `BEGIN IMMEDIATE` 事务内迁移 `notes`、`facts`、`note_candidates`、`edges`、`agent_project:*` meta 与 `project_path`；`scope_aliases` 最后写入。
6. `chunks` 有 `(hash, scope) WHERE deleted_at IS NULL` 的部分唯一索引。目标 scope 已有同 hash 活跃行时，源行 tombstone（保留审计），不硬删除、不覆盖目标行；其余 chunk 直接改 scope。
7. 写入/读取仍以 canonical scope 为准；`attachSession` 返回 canonical key，`projectByAgent` 与 `agent_project` meta 同步更新。

## 后果

- 同一工作区在 Windows/macOS 上无论大小写都命中同一项目层；Linux 保持原语义。
- 升级后第一次打开旧库会迁移当前路径可推导的旧键；迁移是幂等的，并有 `scope_aliases` 可审计。
- 没有路径记录的历史键不会被猜测合并；需要时可通过 `scope_aliases` 显式补齐（见 REFERENCE 的运维说明）。
- 迁移会重写 source 行的 `scope`，但保留 id、文本、revision、墓碑与反馈；`chunks` 冲突行只增加 `deleted_at`。
- 备份/导入仍按 scope 字符串工作；导入到旧键后再次打开可按 alias 合并。

## 验证

- `test/scope-alias.test.mjs`：Windows/macOS 大小写同键、Linux 不同键、旧 scope 迁移与重开幂等、chunk 同 hash 冲突 tombstone。
- 真实库副本迁移：`proj:全息记忆#deff23` → `proj:全息记忆#30534c`，40 条 notes、12 条 facts、12 条 edges 保留；`--scope project` 命中。
- 完整 `npm test` 288/288；`npm run check` 通过。

## 3.10.2 补充：旧键残留自愈

3.9.4 的迁移依赖 `ensureProjectAlias`，但旧键一旦已经写过 `scope_aliases`，后续 `resolveScopeAlias(legacy)` 会先把它解析成 canonical，导致 `legacy !== canonical` 不成立，旧键不会进入迁移候选；同时 `migrateScopeAlias` 也把 `from` 解析成 canonical，出现 `source === target` 的假 no-op。结果是 alias 已记录、行仍留在旧键。

3.10.2 的补充决策：

1. `resolveProjectKey(db, cwd)` 成为所有入口的统一解析；`resolveTranscriptScope`、`candidateScope`、`projectForAgentId`、`projectForScope`、`rememberUserMessage`、`/packet`、`attachSession`、`scopeForSession` 都先走 alias。
2. `migrateScopeAlias(db, from, to, { literal: true })` 不解析 `from`，按字面旧键迁移；target 仍解析。CLI `scope-alias --apply` 显式使用 literal，避免运维命令也掉进同一个假 no-op。
3. `ensureProjectAlias` 始终把 `legacyProjectKeyFromCwd(raw)` 的原始键、`project_path:*` 路径相等命中的原始键、以及 `scope_aliases` 中 canonical 指向当前键且仍有行的 alias 加入候选；有行则按 literal 迁移，无行只补 alias。
4. `repairScopeAliases(db)` 在 `openStore()` 拿到维护租约并完成 `migrate()` 后运行：扫描 `scope_aliases` 中 `alias <> canonical` 的记录，有行就迁移；成功后写 `scope_alias_repair_version='1'`，失败写 `scope_alias_repair_last_error` / `scope_alias_repair_failed_at`，下次启动重试。结果通过 `/omni-memory/status` 的 `aliasRepair` 暴露。
5. 验证：`test/project-key-resolution.test.mjs` 3 例、`test/project-key-repair.test.mjs` 1 例；真实库修复后 `proj:全息记忆#767039` 的 10 条 chunks 并入 `proj:全息记忆#604dba`（7 → 17），旧键 0 行，`repairMarker=1`，alias 保留。

