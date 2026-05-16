# Future Plan

本文档记录已经讨论过、但当前暂不实现的功能方向，避免后续重新研究。

## PDF 图文选区提问（暂缓）

状态：暂缓。当前版本继续优先保证纯文字选区提问、解释选区、任务队列和跳转标记稳定，不在本轮实现自动图文匹配。

### 背景

在论文 PDF 中，用户可能选中包含图片、图注、子图说明和正文的混合区域。PDF 的文本层经常与视觉布局不一致，尤其在多栏论文、跨页图、复杂图表、图片内部文字和乱码文本层中，直接把 PDF 选区文本发送给模型会出现：

- 图像区域被解析成严重乱码。
- 视觉上相邻的图片和图注，在文本层中并不相邻。
- 多个子图 `(a)`、`(b)`、`Fig. 6`、`Fig. 7` 的说明可能被错误绑定到另一张图。
- 自动拆分多个图片时，可能出现“图片 #1 搭配了图片 #2 的说明”的错配。

### 当前结论

这种图文提问方式仍然可能将图片和文字匹配错误。更稳妥的方向不是强行做精确匹配，而是采用保守的“图文区域截图”策略：

- 可靠文字继续使用 Zotero 官方选区思路获取：`_selectionRanges + chars`。
- 严重乱码不发送给模型，改为过滤并用 `[Image #n]` 标记替代。
- 图片区域截图时，尽量把图片、子图标题、图注和局部说明包含在同一张截图里。
- 多图边界不确定时，优先合并成更大的图文截图，而不是错误拆成多张。
- 只有在 `(a)`、`(b)`、`Fig. n` 等结构和几何位置都比较明确时，才考虑拆成多张图。

### 候选设计

后续如果实现，可以增加一个 `getSelectedPdfContextForPrompt()`，返回结构化上下文：

```ts
{
  text: string;
  images: MessageImage[];
  diagnostics?: {
    filteredGibberishLines: number;
    imageRegionCount: number;
    mappingConfidence: "high" | "medium" | "low";
  };
}
```

提示词中的组织方式可以是：

```text
[Image #1: Fig. 6，包含环境图片和完整图注]
Fig. 6: Evaluation environments...
```

对于明确的多子图：

```text
[Image #1: Fig. 7(a)，包含 rollout 图片和 (a) 说明]
[Image #2: Fig. 7(b)，包含定量结果图片和 (b) 说明]

Fig. 7 shared caption for Image #1 and Image #2:
Fig. 7: Evaluation in real homes...
```

对于边界不明确的多图：

```text
[Image #1: Fig. 7 整体图文区域，包含所有子图、子图说明和完整图注]
```

### Zotero 官方思路参考

- 文字选区：参考 Zotero Reader 的朗读/选区实现，使用 selection range 的字符索引，而不是 DOM selection 或纯 rect 反推文本。
- 图片区域：参考 Zotero Area/Image annotation 的做法，用 PDF `position.rects` 通过 PDF.js 渲染区域截图。
- 第一版应优先保证“不严重错配”，而不是追求自动精确拆分。

### 暂不实现范围

- 暂不做复杂图文自动分组。
- 暂不做 OCR 识别图片内部文字。
- 暂不做跨页图文匹配。
- 暂不把该功能接入当前任务队列和跳转标记逻辑。

## Library / 多篇维度功能（暂缓 / 大概率不做）

状态：2026-05-15 的设计讨论后，结论是当前不开发任何 library 维度功能。本节记录讨论结论，避免后续重复脑暴。

### 产品立场（重申）

本插件定位是**「认真深读单篇论文的工具」**，不是「研究助手 / 批量处理工具」。所有 7 个现有 agent tool（`zotero_get_current_pdf_selection`、`zotero_get_reader_pdf_text`、`zotero_annotate_passage`、`zotero_append_to_note`、`draw_article_mindmap` 等）都是 reader / 单 PDF 维度，这是有意的产品 DNA，不是缺口。

衡量"该不该加 library 功能"的核心问题：**这件事是让用户读得更深，还是让用户读得更多？** 后者一律不加。

### 三种架构选项的评估

讨论过把多篇维度功能放在哪里：

| 方案 | 结论 | 理由 |
| --- | --- | --- |
| **同一个 XPI 集成** | 唯一可考虑的方案 | 复用全部 provider/settings/chat-history 基础设施；用户心智模型一致 |
| **单独开新 XPI** | ❌ 否决 | 几乎零真实收益 + 双倍维护成本（重复 providers/settings/chat-history）+ 用户要管两套配置 + 跨 XPI 通讯在 Zotero 里很别扭 |
| **MCP server 给终端用** | ❌ 当前否决 | 仅在「想让 Claude Desktop / Cursor / Codex 等外部 client 也能读用户 Zotero 库」成为目标时才考虑；当前不是目标。Zotero SQLite 运行时被锁、annotations/full-text 出库麻烦、失去 in-context UX |

### 评估过的具体功能（按"批量 vs 深读"分类）

**❌ 明确不做（属于"批量处理"）：**

| 功能 | 否决理由 |
| --- | --- |
| 跨论文综合 / 对比 N 篇（`zotero_get_items_fulltext_summary` 之类） | 直接是批量；违背产品立场 |
| 跨笔记综合 / 把多篇笔记合成一份 writeup | 同上 |
| 全库语义搜索 / "我的库里哪几篇说过 X" | 需要 embedding 索引 + 增量同步 + 跨设备 sync；典型用户库 < 200 篇时 Zotero 内置搜索已够；维护负担大、出错点多 |
| Collection 总结 | 等同于"选中 collection 里所有 item 然后批量总结"，纯批量入口 |
| 自动 tag / 元数据清理 / 找重复 | 与 Zotero 自带 dedupe / tag 系统强项打架；LLM 加 tag 容易和用户 tag 体系不一致反而增加清理负担 |
| 后台跑的"library 健康度报告" | 后台 + 全库 = 两条红线 |
| 引用图谱 / 相关论文推荐 | 不属于本地 library 维度；需外部 API（Semantic Scholar 等），归 `MCP_AND_SKILLS_BRAINSTORM.md` 的内置 AgentTool 路径（PR-7） |

**⚠️ 评估过但当前结论"没必要"的（即使按 Zotero 的 `mergeSelectedItems` / `relateSelectedItems` / `Generate Report from Selected Items` 模式做成"用户主动选中 + 一次性产出 + 显式 artifact"也仍然砍掉）：**

| 功能 | 模仿的 Zotero 原语 | 砍掉理由 |
| --- | --- | --- |
| AI 报告（右键选中条目 → 生成结构化综述笔记） | Generate Report from Selected Items | 实现合理但**用户没真痛点**；Zotero 自带 Report 已经满足"我要把这几篇导出"的基本需求 |
| AI 推荐"相关条目"（item pane 按钮，限范围找候选 + 用户逐项确认） | `relateSelectedItems` (zoteroPane.js:2323) | 用户手动 relate 频率本来就低，AI 推荐的频率更低 |
| AI 阅读路线生成（选 N 篇 → AI 排序灌入 reading route） | reading route + collections | reading route 用户实际使用模式还没成型；自动排序就是猜 |
| AI tag 建议（**严格约束在用户已有 tag 集合**） | tag selector | 用户 tag 体系乱时 AI 帮不上；tag 体系清晰时用户自己也容易标；甜区窄 |

### 关键的反复确认事项

1. **"用户主动选中多 item 操作"≠"批量处理"**：Zotero 自己有大量这种操作（merge / relate / report / findFiles / tag），都是用户在 items pane 选中后右键/菜单显式触发、一次性产出可见 artifact。所以"selection-driven 的 AI 多 item 操作"在架构上不是禁区。
2. **但是"架构允许"≠"应该做"**：即使做了符合 Zotero 设计哲学的版本（见上表），评估下来仍然没有真痛点。开 selection-driven 的口子还有副作用 —— 一旦做了"对选中 N 篇做 X"，用户预期会拉向"那能不能对比""那能不能批量打标签"，**架构选择会塑造产品方向**。
3. **MCP 不在这次讨论的解决方案空间里**：MCP 适合的场景是"对外暴露 Zotero 给其他 AI client"，不是"在我的插件里做更多事"。对内功能用 in-process function-calling 永远是更直接的选择（详见 `MCP_AND_SKILLS_BRAINSTORM.md`）。

### 何时可以重新讨论这一块

只在下面**任一**情况发生时重开此讨论（不要主动重启）：

- 用户**具体**反馈某个 library 维度场景的痛点（例："我在 reader 里读 X 时希望直接看到我之前写过的相关笔记"），并且**至少 3 次独立反馈**
- reading route 用户使用数据明确显示"手动建顺序"是高频痛点
- 出现要把 Zotero 库暴露给外部 AI client 的真实需求 → 那时讨论 MCP，不讨论本地 library 工具
- 产品定位主动从"深读单篇"调整到别的方向（这是更大的决策，不是 feature 级别）

### 真正应该优先的方向（替代清单，全部已在其他 docs 里）

讨论中明确：与其加 library 功能，不如继续推进**已经在 backlog 的深化方向**：

- PromptShortcut 重构（`MCP_AND_SKILLS_BRAINSTORM.md` PR-2/3/4）
- Anthropic 客户端工具循环（同上 PR-5）
- PDF 图文选区提问（本文档第一节，目前暂缓）
- reading route 实际使用反馈后的演进
- 现有深读流程的打磨（流式滚动、context budget 调优、note 体验细节）
