# 3.9.4 完成报告：跨平台项目键归一与旧 scope 迁移

日期：2026-11-21 · 版本：3.9.4 · 前置复核：`docs/RECHECK-3.9.3-2026-11-21.md`

## 结论

3.9.3 七项语义修复已由独立复核确认。本版只做复核剩余的两条主线：P1 跨平台路径大小写造成的项目层分裂，以及 P3 的资产校验、署名与口径收尾。

P1 的核心不是“把路径转小写”，而是**转小写后让旧键的数据仍然可见**。本版用 schema v15 的 `scope_aliases` 做一次性、可审计的迁移：只迁移能由完整路径确定的旧键，不按目录名猜测合并。

## 修复

### 1. 路径键归一

`projectKeyFromCwd(cwd, platform)` 先规范化分隔符与尾部斜杠；Windows/macOS 在计算 FNV-1a 前转小写，Linux 保留大小写。旧算法拆到 `legacyProjectKeyFromCwd`，仅用于识别旧键。

效果：`D:\Repo`、`d:\repo`、`D:/Repo/` 在 Windows/macOS 上得到同一个 `proj:*#*`；Linux 上 `/home/me/Repo` 与 `/home/me/repo` 仍不同。

### 2. schema v15：scope_aliases

新增：

```sql
CREATE TABLE scope_aliases (
  alias TEXT PRIMARY KEY,
  canonical TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX scope_aliases_canonical ON scope_aliases(canonical);
```

`resolveScopeAlias` 沿链解析；`migrateScopeAlias` 在单个 `BEGIN IMMEDIATE` 事务内：

- 迁移 `notes`、`facts`、`note_candidates`、`edges` 的 scope；
- 更新 `meta.agent_project:*` 中保存旧 scope 的值；
- 维护 `project_path:<canonical>`，删除旧路径键；
- 最后写入 `scope_aliases(alias, canonical)`，保证中断可重试；
- `chunks` 的 `(hash, scope) WHERE deleted_at IS NULL` 唯一索引发生冲突时，目标行保留，源行写 `deleted_at`，不硬删、不覆盖。

`ensureProjectAlias` 在 `openStore(process.cwd())`、`attachSession`、`scopeForSession` 调用。自动迁移的候选只有两类：当前路径算出的旧键，以及 `project_path:*` 中完整路径相等的旧键。没有路径证据的历史键保持原样，避免同名不同盘误合并。

### 3. 迁移实测

用真实库 `VACUUM INTO` 副本（不动线上库）运行：

- 旧键 `proj:全息记忆#deff23` → canonical `proj:全息记忆#30534c`；
- `notes` 项目层 40 行、`facts` 12 行、`edges` 12 行迁移后仍为 40/12/12；
- `notes` 全局层 1230 行不变；
- `scope_aliases` 出现 `deff23 → 30534c`；
- `project_path:proj:全息记忆#30534c` 写入 `D:/xiangmu/全息记忆`；
- 再次用 `D:/XIANGMU/全息记忆` 打开不重复迁移；
- `omni search 经济 --scope project` 命中 `proj:全息记忆#30534c`。

### 4. P3 收尾

- `scripts/check-semantic-assets.mjs`：11 个模型/WASM/许可证文件同时校验字节数与 SHA-256；输出改为 `MiB`。
- `ATTRIBUTION.md`：补 `Xenova/bge-small-zh-v1.5` ONNX 导出来源。
- `nulls` 口径：`notes.scope` NOT NULL 不把 NULL 当 global；`facts/chunks/edges` 的 legacy NULL 仍兼容为 global，并在 REFERENCE 显式写明。
- `memory_reindex`：顶层 `processed` 明确为当前向量后端写入行数；语义回填数量只在 `semantic.processed`，文档不再暗示两者相加。
- 文档体积统一标注 MiB；README 写明 22.8 MiB 模型 + 14.2 MiB WASM。
- 按真实 MCP `tools/list` 修正文档计数：25 个工具（23 个内核 + 2 个适配工具）、20 条 REST 路由；同步修正 `hosts/mcp/README.md` 的 17/19/13 与 `>=24` 陈旧数字。

## 验证

- `npm test`：**288/288**（新增 3 个 scope alias 用例）。
- `npm run check`：`288 tests, 23 tools, 20 routes, 31 ADRs, version 3.9.4`；`semantic assets OK: 11 files, 37.5 MiB`。
- `npm run bench:golden`：词面 0.776 / hashed 混合 0.927 / 四路完整 0.979，`pass:true`（与 3.9.3 一致，P1 不改检索路线）。
- `npm pack --dry-run`：`@local/omni-memory@3.9.4`，87 entries，18.4 MB 压缩、41.0 MB 解包；复核报告与 `GAP-REVIEW`/`INTEGRATION-PROBE` 已从包内排除。
- `node --check index.js` 通过。
- 副本迁移与重开幂等通过。

## 未纳入

- 历史旧键没有保存原始路径时不会被自动合并；需要时可显式补 `scope_aliases` 映射。本版不提供自动猜测或批量合并。
- 计划任务仍是登录后运行；注销/关机/休眠会停止服务。若需要注销后常驻，应另迁 Windows 服务或 S4U，属于部署形态变更。
- `docs/RECHECK-3.9.3-2026-11-21.md`、`docs/RECHECK-3.9.2-2026-11-21.md`、`docs/GAP-REVIEW-2026-11-21.md` 未纳入版本库。

## 发布

- 功能提交 `97c81a8`（`feat: normalize project keys across platforms (3.9.4)`），已推送 `origin/main`；本次文档状态修订随后提交。
- 7788 服务由隐藏计划任务 `OmniMemory7788` 静默拉起，当前 `health` 返回 `version:"3.9.4"`、`project:"proj:全息记忆#30534c"`、`tools:25`；node 与 PowerShell 宿主 `MainWindowTitle` 均为空。
- 真实库已迁移：旧键 `deff23` → `30534c`，`notes` 40 行、`facts` 12 行、`edges` 12 行保留；`--scope project` 命中。
