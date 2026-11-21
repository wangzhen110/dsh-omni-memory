# 二次评审复核记录

复核日期：2026-11-21
复核对象：`docs/REVIEW-2026-11-21.md`

## 1. 测试失败：属实，已修复

报告所述 `concurrent processes write to one store without losing rows` 失败可复现：连续运行 20 次，原代码失败 3 次，错误为：

```text
EBUSY: resource busy or locked, rmdir '...\Temp\omni-concurrency-...'
```

继续压测后还复现了更底层的错误：

```text
Error: database is locked
at openStore (index.js:355)
db.exec('PRAGMA journal_mode = WAL')
```

根因不是单纯的临时目录清理：多个进程首次打开同一个新库时，`journal_mode = WAL` 在 `busy_timeout` 设置之前执行，抢写锁时 SQLite 立即报锁；进程退出后 Windows 又短暂持有目录句柄，形成 EBUSY。

修复：

- `index.js`：把 `PRAGMA busy_timeout` 移到 `journal_mode = WAL` 之前。
- `test/concurrency.test.mjs`：临时目录清理增加针对 `EBUSY` / `ENOTEMPTY` / `EPERM` 的条件重试。

验证：并发用例连续 20 次全部通过；完整 `npm test` 连续 3 次 **246/246 通过**。

## 2. project 伪层级：报告结论与当前代码不符

报告称 `/search` 与 `/node` 仍把 `project` 当字面 scope。实际当前代码已经支持：

- `scopeClause()`：`scope === 'project'` 返回 `AND <column> LIKE 'proj:%'`。
- `scopeAllows()`：`scope === 'project'` 判断 `startsWith('proj:')`。
- `/omni-memory/search?scope=project` 实测命中全部项目层、排除 global。
- `/omni-memory/node?node=n:<project-note>&scope=project` 返回 200；global 节点返回 404。

已新增回归用例 `lifecycle matrix: panel pseudo-scope project spans every project, not global`，锁定该语义。当前不需要重复修改；报告该项应标记为「已支持」。

## 3. 本轮边界

本轮只修复稳定性与并发正确性，并补 project 伪层级回归，不扩展新功能。竞品对标提出的自动抽取、反馈闭环、rerank、宿主无关 ingest 等属于产品能力扩展，未在本轮实施。

当前基线：`npm test` 246/246、`npm run check` 通过、版本 3.6.1。
