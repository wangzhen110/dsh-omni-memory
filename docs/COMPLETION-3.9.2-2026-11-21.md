# 全息记忆 3.9.2 完成报告：零配置本地语义

日期：2026-11-21
版本：3.9.2
状态：实现、测试、文档、发布闸门完成；待提交并推送 GitHub main。

## 问题

3.9.1 的默认向量是 512 维 hashed 字符 n-gram。它能排序，但不能理解同义改写。实测“那个把界面弄没的坑”与“调用 inspectSession 会把实时投影顶掉”没有共享汉字，hashed 召回为 0。

用户给出的约束是不做取舍：大多数用户配不齐 Ollama / LM Studio，也不该要求 API key；默认必须开箱即用。宿主 AI 的聊天接口只返回文本，不返回 embedding；MCP sampling 返回 completion，不是稳定向量，且不是所有宿主支持；Claude / Anthropic 没有 embeddings API。因此不能把宿主 AI 当作通用插件的向量源。

## 方案

模型与运行时随插件走，用户侧零安装：

- `BAAI/bge-small-zh-v1.5` int8 ONNX，MIT 许可；模型权重 23,903,394 字节。
- `onnxruntime-web` WASM 1.31.1；`ort.wasm.bundle.min.mjs` 77,024 字节、`ort-wasm-simd-threaded.wasm` 14,848,852 字节、`ort-wasm-simd-threaded.mjs` 24,738 字节。
- HuggingFace tokenizers WASM 36,601 字节，Apache-2.0。
- 进程内 CPU 推理，默认离线；不需要 Ollama、LM Studio、API key。
- CLS pooling + L2 normalize；查询加 BGE 指令前缀，文档不加。
- 独立 `semantic_vectors(kind, owner_id, model, dim, vec)` 表；`model` 存签名 `local:bge-small-zh-v1.5:int8:512`，不覆盖旧 `vectors`。
- 检索增加第四路语义，四路 RRF；权重词面 1、hashed/远程 1、本地语义 2、图 0.5。
- 新写入进队列，后台 worker 每批 8 条；检索前先冲刷一小批，保证同轮写入后立刻可召回。
- 旧库打开时先检查缺向量行，有才启动回填；回填持有 `semantic-backfill` 跨进程租约，进程退出即释放；每轮每层最多扫描 64 条，不阻塞回合；已索引库启动时不加载模型。
- `memory_reindex({semantic:true})` 强制回填；`semanticStatus` 暴露 `enabled/model/dim/pending/indexed/running/backfillDone/lastError`。
- 默认开启；`OMNI_DISABLE_SEMANTIC=1` 单独关闭；`OMNI_DISABLE_VECTOR=1` 同时关闭 hashed/远程与本地语义（诊断用）。

## 实测结果

独立模块：

- 冷加载 208ms；RSS 216MB；输出维度 512。
- 20 次查询 191ms，约 9.5ms/query。
- 单条写入语义向量约 10.7ms（32 条 344ms）。
- “C盘满了怎么清理”对“磁盘满了，如何释放系统盘” cosine 0.730。

黄金集（20 条语料 / 24 个问题）：

- 纯词面：recall 1.000、MRR 0.776。
- hashed 混合：recall 1.000、MRR 0.927。
- 四路完整（本地语义 + hashed + 词面 + 图）：recall 1.000、**MRR 0.979**。
- 等权四路曾只有 0.938；把语义权重调到 2 后恢复到 0.979。

端到端 smoke：

- 写入“调用 inspectSession 会把实时投影顶掉，聊天区变空白”。
- `memory_reindex({semantic:true})` 248ms，返回 `processed:1, queued:0, backend:"local"`。
- 查询“那个把界面弄没的坑”：命中，`semanticScore:0.4639`，`lexicalScore:null`。
- 查询“inspectSession”：命中，`lexicalScore:0.98`、`semanticScore:0.413`。

## 闸门

- `npm test`：**283/283 通过**。
- `npm run check`：283 tests / 23 tools / 20 routes / 29 ADRs / 3.9.2；`semantic assets OK: 11 files, 37.5 MB`。
- `npm run bench:golden`：pass=true，完整检索 MRR 0.979。
- `npm pack --dry-run`：包名 `@local/omni-memory@3.9.2`，83 个文件，解包 41.0MB，压缩 18.4MB；模型与 WASM 均在包内。
- `scripts/check-semantic-assets.mjs` 校验模型、tokenizer、WASM、许可证的存在和精确字节数，缺文件或截断会让 `npm run check` 失败。

## 文档与许可

- README：安装说明增加“语义检索开箱即用”，配置表增加 `OMNI_DISABLE_SEMANTIC` / `OMNI_SEMANTIC_MODEL_DIR` / `OMNI_SEMANTIC_BATCH`；指标更新为 283/283、MRR 0.979。
- DESIGN：版本 3.9.2、schema v14、FR-41、NFR-10/12 计数、6.5.1 本地语义路线、M-6 里程碑。
- REFERENCE：schema v14、四路检索、`semantic_vectors` 表、`memory_reindex semantic`、环境变量、文件地图。
- CHANGELOG：新增 3.9.2 条目。
- THREAT-MODEL：本地语义默认不联网、模型文件完整性闸门、216MB RSS 与模型供应链残余风险。
- ADR-029：记录选型、体积、实测、被否方案；ADR-007 标记为部分被取代。
- ATTRIBUTION：列出 BGE（MIT）、ONNX Runtime（MIT）、tokenizers（Apache-2.0）三项随包组件与许可文件。

## 已知边界

- 语义与 hashed 向量一样，对最近 5000 条向量做 JS 余弦扫描，并加入词面候选；十万级以上冷门纯语义命中仍需要 ANN。
- 每进程常驻约 216MB RSS；测试默认 `OMNI_DISABLE_SEMANTIC=1`，只有 `boot({ semantic: true })` 才加载模型。
- 模型升级要发版；旧签名向量不会污染新签名，但需要清理或按新签名重建。
- 模型缺失、WASM 加载失败、内存不足或推理异常时语义路线返回空并写 `lastError`；词面/hashed/图继续工作。

## 待办

- 提交并推送到 GitHub main。
- 线上服务仍是旧 3.9.1 进程（PID 15436，端口 7788），需要重启后才会加载 3.9.2 与语义 worker。
