# ADR-029：零配置本地语义检索

- 状态：已采纳（3.9.2）
- 日期：2026-11-21
- 关联：FR-17、FR-21、FR-36、FR-41、NFR-07、NFR-10

## 背景

3.9.1 的默认向量后端是 512 维哈希字符 n-gram。它能改善排序，但不理解同义改写：
“那个把界面弄没的坑”与“调用 inspectSession 会把实时投影顶掉”没有共享汉字，哈希余弦无法召回。

远程 OpenAI 兼容 `/embeddings` 能解决质量，但要求用户配 key、联网并把正文外发；Ollama / LM Studio 要求用户另装服务、拉模型。用户给出的约束是：**大多数用户配不齐本地模型，不做取舍，默认必须开箱即用。**

另一个被排除的方向是“直接用宿主 AI”。宿主聊天接口通常只返回文本，不返回 embedding；MCP sampling 返回的是 completion 文本，不是稳定向量，且并非所有宿主支持；Claude / Anthropic 没有 embeddings API。宿主模型可以用于查询改写或候选重排，但不能作为通用插件的稳定向量源。

## 决策

把模型与运行时打进插件安装包，用户侧零配置：

- 模型：`BAAI/bge-small-zh-v1.5`，int8 ONNX 导出，MIT 许可，可随包分发。
- 推理：`onnxruntime-web` 的 WASM 构建，进程内 CPU，不引入 `onnxruntime-node` 原生二进制。
- 分词：`@huggingface/tokenizers` 的 WASM 构建，Apache-2.0。
- 池化：BGE 的 CLS pooling，再做 L2 归一化；查询加模型卡推荐指令，文档不加。
- 默认离线：不下载、不联网、不需要 API key、不需要本地服务。
- 开关：`OMNI_DISABLE_SEMANTIC=1` 单独关闭；`OMNI_DISABLE_VECTOR=1` 同时关闭 hashed/远程与本地语义，仅用于诊断。
- 目录：`OMNI_SEMANTIC_MODEL_DIR` 可替换同结构模型；`OMNI_SEMANTIC_BATCH` 控制批大小（默认 8，范围 1–64）。

发布包体积约 39MB：

- `model_int8.onnx` 23,903,394 字节
- `tokenizer.json` 439,125 字节
- `tokenizer_config.json` 367 字节
- `config.json` 716 字节
- `ort.wasm.bundle.min.mjs` 77,024 字节
- `ort-wasm-simd-threaded.wasm` 14,848,852 字节
- `ort-wasm-simd-threaded.mjs` 24,738 字节
- `tokenizers.min.mjs` 36,601 字节

许可证文件随包：模型卡含 MIT 声明，`TOKENIZERS-LICENSE.txt` 为 Apache-2.0，`ONNXRUNTIME-LICENSE.txt` 为 MIT。`scripts/check-semantic-assets.mjs` 在 `npm run check` 中校验每个文件的字节数，缺文件或截断直接失败，避免“静默退化为无语义”。

## 存储与检索

新增独立表，不覆盖已有 hashed `vectors`：

```sql
CREATE TABLE semantic_vectors (
  kind TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  PRIMARY KEY (kind, owner_id, model)
);
CREATE INDEX semantic_vectors_model ON semantic_vectors(model);
```

`model` 存签名 `local:bge-small-zh-v1.5:int8:512`，而不是裸模型名。hashed 512 维与本地 512 维数值空间不同，混存会得到错误的余弦；按签名隔离后，老库可以继续用 hashed 路线服务检索，同时后台回填本地语义。

检索变成四路：词面、hashed/远程向量、本地语义、图游走，用 RRF 融合。四路权重为词面 1、hashed/远程 1、本地语义 2、图 0.5；等权版本黄金集 MRR 只有 0.938，提高语义权重后达到 0.979。`memory_search` 结果新增 `semanticScore`，`via` 可为 `semantic`。本地语义阈值 `SEMANTIC_MIN_COSINE=0.25`：实测真改写对 0.479–0.621，不相关中文约 0.217，中英不相关约 0.288，0.25 能收进真改写并挡住大部分噪声。

新写入进入内存队列，后台 worker 分批写入；检索前先冲刷一小批待处理项，保证“同一轮写入后立刻提问”也能被语义召回，而不依赖定时器。旧库首次打开时先检查是否存在缺向量行，有才启动回填；回填持有 `semantic-backfill` 跨进程租约，进程退出即释放，避免 N 个宿主同时加载 216MB 模型并重复扫描。扫描上限 64 条/轮，不阻塞回合。`memory_reindex({semantic:true})` 可强制回填。

## 实测

本机 Windows 11，Node 22.23.2，CPU 推理：

- 冷加载 208ms，RSS 216MB。
- 输出维度 512。
- 20 次查询 191ms，约 9.5ms/query。
- 单条写入语义向量约 10.7ms（32 条 344ms）。
- 黄金集 20 条语料 / 24 个问题：本地语义单独 recall 1.000、MRR 0.979；hashed MRR 0.927；纯词面 MRR 0.776。
- 阈值从 0 到 0.20 结果一致，说明质量不靠阈值硬撑。

## 代价与边界

- 包体积增加约 39MB；这是发布方承担的成本，不转移给用户。
- 每个进程常驻约 216MB RSS；测试默认 `OMNI_DISABLE_SEMANTIC=1`，只有真实语义用例 `boot({ semantic: true })` 才加载模型。
- 当前语义检索和 hashed 向量路线一样，在 JS 里对最近 5000 条向量做余弦扫描，并加入词面候选；十万级以上纯语义冷门命中仍需要 ANN。这里保留 ADR-025 的边界，不把 5000 条采样说成无限规模。
- 模型随包意味着升级模型要发版；`semantic_vectors.model` 签名使旧向量不会污染新模型，但旧行需要清理或按新签名重建。
- 模型损坏、WASM 缺失或内存不足时，语义路线返回空，词面 / hashed / 图路线继续工作；状态接口暴露 `lastError`。

## 被否方案

- Ollama / LM Studio：用户要另装服务、拉模型，违背零配置。
- 远程 embedding：要 key、要联网、正文外发；保留为可选覆盖，不做默认。
- Transformers.js 首次下载：首次使用要下 90–120MB，离线或网络受限时不可用。
- `multilingual-e5-small`：模型 118MB + tokenizer 17MB，实测 RSS 844MB，体积和内存都高一个量级。
- Model2Vec：质量低一档，无法达到黄金集 MRR 0.979。
- `@clay-design-system/embeddings`：英文 MiniLM + 约 200MB 原生 `onnxruntime-node`，不适合中文零配置。
- 直接用宿主 AI：没有稳定 embedding 接口，详见背景。
