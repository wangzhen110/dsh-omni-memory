# 署名要求（Attribution）

本项目使用 **全息记忆个人使用许可 1.1**：仅允许个人、非商业使用、修改、借鉴；
**禁止任何形式的商业使用**，尤其**禁止拿源码或架构去做商业替代、竞品或商业服务**，且**必须署名**。
以下是“怎样才算合规署名”的最低要求与可直接复制的模板。

---

## 一、最低要求

只要你的项目**使用了**本项目的代码、文案、设计或算法，就必须同时满足：

1. **写明作者与项目名**：全息记忆 (Omni Memory) · wangzhen110
2. **给出项目链接**：https://github.com/wangzhen110/omni-memory
3. **写明许可协议**：全息记忆个人使用许可 1.1，并附 `LICENSE` 链接
4. **保留版权声明**：转载源码时不得删除本文件、`LICENSE` 及源码中的版权头
5. **说明是否修改**：改过就写「已修改 / Modified」
6. **不得暗示背书**：不能写「官方出品」「作者推荐」等

---

## 二、可直接复制的模板

### 1. README / 文档（中文）

```markdown
本项目部分代码/设计参考或基于「全息记忆 (Omni Memory)」：
- 作者：wangzhen110
- 项目：https://github.com/wangzhen110/omni-memory
- 许可：全息记忆个人使用许可 1.1（见项目 LICENSE）
- 说明：本项目对其进行了修改
```

### 2. README / Docs (English)

```markdown
This project is based on / borrows from "Omni Memory" by wangzhen110:
- Source: https://github.com/wangzhen110/omni-memory
- License: Omni Memory Personal Use License 1.1 (see LICENSE)
- Changes: modified
```

### 3. 源码文件头

```js
// Portions of this file are based on Omni Memory by wangzhen110
// https://github.com/wangzhen110/omni-memory
// Licensed under the Omni Memory Personal Use License 1.1 — personal,
// non-commercial use only; commercial use of modified versions and commercial
// reimplementation based on the source or architecture are prohibited.
// Modified for this project.
```

### 4. 软件界面「关于」页

```text
本软件的部分功能基于「全息记忆 (Omni Memory)」
作者 wangzhen110 · 全息记忆个人使用许可 1.1
https://github.com/wangzhen110/omni-memory
```

---

## 三、常见问题

**Q：我只是“借鉴了思路”，没复制代码，也要署名吗？**
要。即使只借鉴实质性思路，也建议署名。最简做法是在 README 写一句：
「星图交互设计参考自 Omni Memory (wangzhen110)」。

**Q：我在公司内部用，算商用吗？**
算。公司内部用于生产经营、交付客户、内部工具，都属于商业性使用，需要商业授权。

**Q：我改了 30% 代码，是不是就不用署名了？**
不是。修改不改变来源，仍需署名并注明「已修改」。

**Q：我可以把修改版发布到 GitHub 吗？**
可以，只要**非商业**、**保留署名**，并且修改版继续使用同一许可。不得改为更宽松的许可。

**Q：修改版可以商用吗？**
不可以。任何形式的商用都被禁止；修改版商用尤其明确禁止。

**Q：不复制代码，只拿架构、数据模型或接口设计重写一个商用产品，可以吗？**
不可以。本许可把“为商业目的复制、改写、重写、提取架构后重新实现，制作竞品或商业替代”明确列为禁止行为；是否保留原代码、文件名或注释不影响判断。个人、非商业的学习和研究不受此限。

**Q：商业授权怎么拿？**
优先在 GitHub 仓库开 Issue（公开可追踪）：
https://github.com/wangzhen110/omni-memory/issues
也可发邮件到 **64271785@qq.com**（标题写「商业授权 + 用途」）。作者会回复授权范围与费用。

---

## 四、不署名的后果

1. 你的授权**自动终止**，须立即停止使用并删除所有副本；
2. 作者可依据本许可及适用法律追究侵权责任；
3. GitHub 会受理符合条件的下架请求。

---

许可全文见 [LICENSE](LICENSE)。

---

## 五、随包第三方组件

| 组件 | 用途 | 许可证 | 许可文件 |
|---|---|---|---|
| `BAAI/bge-small-zh-v1.5` int8 ONNX | 本地语义嵌入模型 | MIT | `models/bge-small-zh-v1.5/MODEL-CARD.md` |
| ONNX Runtime Web | WASM 推理运行时 | MIT | `lib/vendor/ONNXRUNTIME-LICENSE.txt` |
| HuggingFace Tokenizers (WASM) | 分词 | Apache-2.0 | `lib/vendor/TOKENIZERS-LICENSE.txt` |

这些组件随插件一起分发，但不改变本项目自身的「全息记忆个人使用许可 1.1」。再分发时请保留上述许可文件与版权声明。
