# 3.9.0 复核：自动捕获 / 巩固 / 重排

复核日期：2026-11-21
被评版本：3.9.0（提交 `fb8912d` + `70b045d`）
复核方式：只读审计 + 隔离临时库端到端实测 + 门禁实跑，**未修改任何源码**
测试基线：`npm test` **276/276 通过**（exit=0），`npm run check` 全绿，`npm run bench:golden` pass（recall 1.0 / MRR 0.927）

---

## 一、这次做了什么

上轮成熟度评估列的三个"记忆智能"短板，这次一次性全补上了：

1. **会话自动捕获**（P0）——schema v13 新增 `note_candidates`；`memory_ingest` 写转录 + 按确定性规则抽最多 3 条 pending 候选（不调模型、不直接写正式笔记）；`memory_candidate` 提供 list/accept/reject，接受后才落 note、拒绝保留 reason。
2. **经验巩固**（P1）——`memory_consolidate` 按同一 problemKey + 精确 scope 合并活跃笔记，默认 dry-run，apply 生成带来源链的摘要、汇总反馈计数、旧行只写 `superseded_by` 不删除。
3. **可选 rerank**（P1）——`lib/rerank-provider.mjs` 支持 Cohere/Jina/SiliconFlow/自建端点，`OMNI_RERANK_*` 配置后重排，未配置零开销、失败静默回落。
4. 附带：分层画像（全局→当前项目→相关事实）、本地语义嵌入预设（ollama/lmstudio）、候选纳入备份、检索去重优先 note/fact、核心规则拆出 `lib/capture-rules.mjs`。

规模：index.js 5258→5938 行，工具 20→23，schema v12→v13。

---

## 二、端到端实测结果（独立验证，非项目自带测试）

| 检查项 | 结果 |
|---|---|
| `memory_ingest` 带 `scope=all` | ✅ **拒绝**（`transcripts cannot be written to scope=all`） |
| 正常 ingest + 候选抽取 | ✅ 落 chunk，返回候选（本次抽到 1 条），scope=proj:alpha 正确 |
| 候选跨项目 accept（global 上下文操作 proj:alpha 候选） | ✅ **拒绝**（`candidate not found or outside the current project`） |
| 候选跨项目 reject | ✅ **拒绝** |
| 显式 `scope=all` accept 跨项目候选 | ✅ 放行（审计路径，符合设计） |
| `memory_consolidate` 带 `scope=all` | ✅ **拒绝**（`all/project would mix layers`，防跨层混合） |
| consolidate 笔记不足 | ✅ 返回 `not enough active notes`，不误写 |
| `memory_search` rerank=true 但未配置 provider | ✅ 正常返回，无外部调用、无报错 |

**结论：关键安全边界全部正确。** 特别是跨项目隔离——accept/reject 默认按当前项目 + global 过滤，`scope=all` 才跨项目，与上一轮修好的 `memory_get`/`memory_feedback`/`memory_amend` 语义一致。

## 三、代码级审查（我独立核对的高风险点）

1. **rerank 的 id 映射**（最危险点，映射错位会返回错误记忆）——`lib/rerank-provider.mjs:54-62` 严格校验 `index` 为整数且 `0 ≤ index < scores.length`，缺分补 0；`index.js:2870-2876` 用 `scores[index]` 按 ranked 输入顺序一一对应，并混合原分数（0.25）+ rerank 分（0.75）+ exactProblem 保护，失败 catch 回落。**映射正确，无错位风险。**
2. **rerank 调用次数**——`maybeRerank` 在 2930 与 2971 两处，但二者是互斥分支（前者 `return`），每次搜索只调用一次，不会双重付费。
3. **consolidate 事务**——apply 分支在 `transaction()` 内重新查询活跃笔记（防 dry-run 到 apply 之间的竞态），重算摘要，插入摘要行 + 批量更新 `superseded_by` 全在事务内，失败会回滚。**无半状态风险。**
4. **consolidate 字段保真**——摘要行透传 `contested=0`、`solution_status`、`reuse_count`、`last_used_at`、`evidence`、全部 4 个反馈计数；`source: consolidate:<ids>`、`evidence: sources: n:<id>...`，来源链完整；摘要 `.slice(0,4000)` 有上限。
5. **候选写入字段**——`writeCandidateNote` 在事务内做 `(scope,text)` 二次查重（防并发重复落库），`source` 标注 `candidate:<id>`，importance 0.55。
6. **备份完整性**——项目已有 `test/backup.test.mjs:94` 覆盖候选的导出/导入/接受，导入按 `hash+scope` 只恢复 pending，避免已审行回流。
7. **去重优先级**——检索去重时优先 note/fact 而非原始 chunk，避免"结论被转录遮住"；golden MRR 仍 0.927，未回退。

---

## 四、需要指出的两点（非阻塞，建议后续优化）

> 以下不是 bug，不影响正确性，属于可优化项。

1. **rerank 成本**：`maybeRerank` 对**全部** ranked 候选（可能上百条）做重排，而非 top-N。功能正确，但如果接了付费 rerank 端点，每次搜索都会提交全部候选，成本偏高。建议改为只对 top-20 重排。
2. **候选审核的原子性**：`reviewNoteCandidate` 的 accept 是"写 note + 更新候选状态"两步，外层无事务。虽然 `writeCandidateNote` 内部有事务去重（重复 accept 会 deduped 返回同一 note），但最终一致性依赖去重逻辑兜底，不如把两步放进一个事务干净。极端并发下可能出现"note 已写但候选状态未更新"的窗口。

---

## 五、进度更新：上轮成熟度矩阵的变化

| 维度 | 上轮 | 本轮 | 变化 |
|---|---|---|---|
| 记忆形成 / 自动抽取 | ★★☆☆☆ 代差 | ★★★★☆ | ✅ 大幅提升——候选抽取闭环落地（确定性规则 + 人工确认，默认不调模型） |
| 梳理 / 沉淀 / 固化 | ★★★☆☆ | ★★★★☆ | ✅ 提升——consolidate 补上了"多条浓缩成一条"，分层画像缓解 1200 字瓶颈 |
| 检索 / 排序质量 | ★★★★☆ | ★★★★☆ | ⚠️ 持平——rerank 通道已建，但未配置端点时默认不生效；语义向量仍是 opt-in |
| 稳定性 / 安全 / 数据 | ★★★★★ | ★★★★★ | 保持——276/276、门禁全绿、跨项目隔离在新功能上延续 |

**总体**：项目从"可靠的记忆数据库"向"会成长的记忆系统"迈了一大步。三条短板里，自动捕获和巩固已实质补齐；重排是"通道就绪、默认未开"，属于能力已备、待用户配置端点。剩下的真正硬骨头是：默认语义检索（需接受成本/隐私权衡）、渐进拆 core（index.js 已近 6000 行）。

---

## 六、深度审计补充发现（第二路返回，我已逐条核实）

第二路只读深审返回，我已对关键项回源码核实。以下发现**均只在配置 rerank 端点时暴露，默认关闭不影响当前用户**：

### M-1【中·已核实】rerank 外发记忆正文，隐私章节未披露
- `lib/rerank-provider.mjs:37-49` 把 `query` + 全部候选的**记忆正文**作为 JSON body 发到所配端点（Cohere/Jina/SiliconFlow 预设或自建 URL），带 Bearer key。
- `README.md:154` 隐私章节只声明 `OMNI_EMBED_URL` 一种外发，声称"不主动上传任何内容"，`DESIGN.md:93` NFR-08 同样遗漏 rerank。
- 属 opt-in（需显式配置，非静默），但"未明确告知"成立。对一个以"默认离线、隐私可控"为卖点的项目，这是应补的文档缺口。**修复**：README 隐私段与 DESIGN NFR-08 补一行说明 `OMNI_RERANK_*` 会外发查询与候选正文，敏感数据建议用自建端点。

### M-2【中·已核实】rerank 分数混合量级错配，"exact 命中保护"承诺失效
- `index.js:2874`：`score = hit.score*0.25 + scores[index]*0.75 + (exactProblem ? 0.25 : 0)`；注释 `:2859-2861` 声称"reranker 无法抹掉强 exact 命中"。
- 但融合路径的 `hit.score` 是 RRF 分数（`1/(60+i+1)`，约 0.016–0.05），*0.25 后 ≤0.013；rerank 分是 0..1，*0.75 后可达 0.75。**rerank 实际主导排序（接近 0/100，而非名义 25/75）**。
- 当两条候选的 rerank 分差 > 约 0.33（=0.25/0.75）时，强 exact-problem 命中会被高分弱命中反超，与注释承诺相悖。
- 另：词面路径（`:2930`）`hit.score` 是 0..1 量级，融合路径（`:2971`）是 0.016..0.5，同一 0.25 权重在两条路径下相对影响力不一致。
- **修复**：混合前把两路分数各自归一化到 0..1，或按量级重配权；补"exact 命中不被覆盖"回归断言。

### 其余低优先级发现（agent 报告，我未逐条复跑，供参考）
- **负分数健壮性**：`:2869` 用 `scores.some(score => score > 0)` 判定，自建端点返回全负 logits 时整段 rerank 被静默跳过。建议改为"存在有限且非 0 的分数"并归一化。
- **去重满结果边界**：`:2660` 的 `if (hits.length >= limit) break` 先于优先级替换，导致排位靠后的 note 无法替换已入选的同文本 chunk；且替换后未重排。测试只覆盖了 note 在前的情况。
- **consolidate scope 一致性**：`:1796` 接受任意精确 scope（如 `proj:beta`），与 feedback/amend 的"当前项目+global"权限模型不一致；但测试明确把跨项目 consolidate 当预期行为，属设计取舍，HTTP 有 loopback+CSRF 兜底。
- **画像边界**：`capProfileLines` 从尾部 pop 可能留下空的 `## 当前项目` 标题，且当前项目内容比 global 先被牺牲——展示瑕疵。

### 深度审计确认「无问题」的关键项
- consolidate：dry-run 不写库、apply 全事务原子性、旧行全标记 superseded、计数/source 完整、边界不误写、HTTP 防护齐全——**未发现缺陷**。
- rerank：index/id 映射三方同序无错位（最危险项排除）、超时/畸形响应/全零分/异常全部回落、默认 off 零开销、golden 门禁不受影响——**未发现缺陷**。
- 分层画像 scope 隔离：默认仅 global+当前项目，跨项目仅显式 `scope=all`——**未发现泄露**。

**建议修复顺序**：① M-1 隐私告知（纯文档，成本最低）；② M-2 分数归一化 + exact 保护回归；③ 负分数判定；④ 去重满结果边界 / 画像空标题。前两项只在开启 rerank 时暴露，可择机修复，非发布阻塞。

---

## 七、捕获队列深度审计补充（第一路返回，关键项我已实证）

第一路只读深审返回，**我逐条实证了最关键的两条**，均属实：

### B1【中·已实证】英文句子不按句点拆分，英文对话自动捕获完全失效
- `lib/capture-rules.mjs:20` 拆句正则 `/(?<=[。！？!?；;])\s*/u` 不含英文句点 `.`；`:22` 又把 >400 字符的单句整段丢弃。
- **我的实测**：
  - 标准 3 句英文（含 `Remember/always/must/decision`）→ 只识别为 **1 句**，候选 1 条（应 3 条）。
  - 2418 字符英文（20 句，含 remember/must/avoid）→ **0 句、0 候选**（整段被当超长单句丢弃）。
  - 对照中文同样结构 → 2 句、2 候选，正常。
- 影响：项目定位 host-agnostic 且规则表内置英文关键词（`capture-rules.mjs:11`），但英文 transcript 无法自动捕获，**功能与定位直接矛盾**。中文用户不受影响，但这是实质功能缺口。
- 修复：英文句点纳入拆句（排除小数/缩写，如 `(?<!\d)\.(?!\d)`），或改用 `Intl.Segmenter({granularity:'sentence'})`。

### B2【中·agent 发现，我未独立复跑】备份二次导入对本地已处理候选不幂等
- `index.js:1269-1272` 的 `candidateExists` 限定 `status='pending'`；`:1423-1430` 导入一律插 pending。
- 触发：备份中候选 X 为 pending → 导入 → 本地 accept/reject X → **再次用同一旧备份导入** → X 以 pending 重新插入，污染审核队列。
- 澄清：快照自带的 accepted/rejected 行会被 `:1300` 正确过滤，不会灌回；缺陷仅在"快照 pending + 本地已处理"组合。note 层有去重，不会重复落 note——属队列一致性问题。
- 修复：`candidateExists` 去掉 `status='pending'` 条件，按 `hash+scope` 存在即跳过。

### B3【低·已实证】`scope=all` 拒写可被大小写绕过
- `index.js:1575` 用 `requested === 'all'` 精确小写匹配。
- **我的实测**：`scope='all'` → 正确拒绝；`scope='ALL'` / `'All'` → **均成功写入**，落到非法 scope `ALL`/`All`。
- 修复：判定改 `requested.toLowerCase() === 'all'`，工具层做 scope 归一化。

### F1【低·agent 发现】accept 落 note 时候选的 confidence/原始 ts 未利用
- `writeCandidateNote`（`index.js:1717-1748`）importance 硬编码 0.55、ts 用 `now()`，丢弃候选自带的 confidence 与原始 ts。
- 澄清：候选表本就无 contested/verification 等列，**未复现 memory_amend 式审计字段丢失**；这是"可用信号未利用"的保真缺口。建议用 confidence 映射 importance 并保留原始 ts。

### 第一路确认「无问题」
- schema v13 完整（MIGRATIONS[12] 与 repair path 两处一致）；HTTP 三路由回环+CSRF 防护完备、只读 candidates GET 豁免正确；CLI `omni ingest --stdin` 无畸形 JSON 崩溃、无命令注入；候选跨项目隔离/reject reason 持久化/并发 accept 幂等（note 层双检去重）均到位。安全缺口 **0**。

### 综合评级（第一路）
安全 A-；数据一致性 B-（B2）；功能正确性 B-（B1/B3/F1）；测试覆盖 B。综合 **B-（可用，建议 3.9.1 修 B1/B2）**。

---

## 八、最终判断（两路审计合并后）

3.9.0 实现了从"可靠记忆库"到"会成长记忆系统"的关键跨越，核心功能正确、安全防护到位、无高危漏洞。但两路深审合计发现 **2 个中等级（rerank 隐私告知 M-1、分数量级错配 M-2）+ 2 个中等级（英文拆句 B1、备份幂等 B2）+ 若干低级别**问题。

诚实结论：
- **默认配置下（未开 rerank、中文使用）**：这些缺陷都不触发，功能稳定可用，测试全绿。
- **开启 rerank 或英文场景下**：会暴露排序保护失效、隐私告知缺失、英文捕获失效等实质问题。
- **无 P0/P1 高危、无安全漏洞**，都属于"用起来会更顺"的优化项，不是"会坏掉"的故障项。

建议 3.9.1 修复优先级：**B1（英文拆句）> M-1（隐私告知，纯文档）> B2（导入幂等）> M-2（分数归一化）> B3/F1/负分数/去重边界**。B1 对"host-agnostic"定位影响最大，应最先修。

---

## 复核边界

只读静态审查 + 隔离环境动态实测，未跑生产库压测，未配置真实 rerank/embedding 端点（故重排与语义的实际质量未独立复测，仅验证代码路径正确性与失败降级）。B1/B3 已由我独立实测复现，M-1/M-2 已回源码核实，B2/F1 及若干低优先级项为深审 agent 发现（我未逐条复跑）。两路深度审计均已返回并合并。本次未修改任何源码，仅新增本报告。
