# Zotero AI Sidebar

[English](README.md) | [中文](README.zh-CN.md)

一个住在 Zotero 里的 AI 论文助手。对正在读的论文问任何问题，侧边栏会自己读 PDF（或者 arXiv 论文的 LaTeX 源），展示推理过程，并把答案写回笔记。

> 👀 **[看它跑起来 —— 6 步交互式 walkthrough →](https://xuhan-rgb.github.io/zotero-ai-sidebar/quick-start.html)**（中/EN 双语，1:1 复刻真实 sidebar UI）

📖 [完整使用指南](docs/USAGE.zh-CN.md) ([English](docs/USAGE.md)) —— 上手、常用场景、功能手册、故障排查。

## 能做什么

- **对正在读的论文随便问** —— *"帮我总结"*、*"核心贡献是什么"*、*"和 X 比较"*。模型自动取它需要的 PDF 内容，并在工具 trace 里把过程显式展示。
- **arXiv 论文公式不破** —— 公式和插图从 LaTeX 源码取，不再是 PDF 文本层里的乱码。*"解释 Eq. (3)"* 和 *"讲一下 Figure 2"* 都能精确命中。
- **PDF 里逐句翻译** —— 点句子即在原文旁显示译文，`Enter` / `Shift+Enter` 在句子间穿行。
- **写回 Zotero** —— 把回答追加到论文笔记，或者让模型给 PDF 加按颜色分类的高亮（按预设的权限模式开关）。
- **想用什么模型用什么** —— Anthropic、OpenAI 或任意 OpenAI 兼容端点，全部在 Zotero 偏好里本地配置。
- **本地优先** —— API key、聊天历史、翻译缓存只留在本机；只有设置走 WebDAV 同步。

## v0.5.1 补丁修复

- **阅读路线笔记保存修复**：保留已有“我的补充笔记”区时，不再把旧笔记 HTML 当作 XHTML 重解析，修复旧阅读路线笔记含 `<br>` 等 HTML 空标签时 Zotero 保存失败的问题。
- v0.5.1 不新增功能；v0.5.0 的功能亮点继续保留在下方。

## v0.5.0 更新

- **以 arXiv LaTeX 源码作为分析上下文**：对于 arXiv 论文，插件会下载源码包、清洗 TeX，把源码而不是 PDF 文本层喂给模型。Equation (1) 以原始 `\mathbb{E}_{\mathcal{D},\tau,\omega}[\ldots]` 抵达模型，不再是被压扁的 `f l θ`。侧边栏头部出现 `LaTeX 源` 徽章，标识当前条目在用 arXiv 源码分析。
- **按需读章节的上下文预算**：固定的前置块只放章节目录；模型用 `arxiv_get_section`、`arxiv_get_bibliography` 等工具按需取正文。非 arXiv 条目以及任何失败路径都自动回退到现有的 PDF 全文流程，不会回退失败。
- **公式 / 插图 / 表格按编号取（arXiv）**：模型新增 `arxiv_get_equation`，`arxiv_get_figure` / `arxiv_get_table` 支持按编号取——问"解释一下 Eq. (3)"或"Table 2 里有什么"，模型直接从缓存的 LaTeX 源里取对应条目。
- **插图作为多模态上下文渲染**：arXiv 工具拉取的插图直接显示在对话里，并在后续轮作为合法的多模态输入回放，多模态模型确实能"看到"图。
- **逐论文公式修复 markdown 缓存（兜底）**：对于非 arXiv PDF，自动识别 PDF 文本缓存里被压扁的公式片段，从 PDF 里渲染裁切公式区域，由视觉模型转写回 LaTeX，整篇论文的修复结果持久化保存。首次问答付转写成本，后续轮复用缓存。
- **对话里渲染 Markdown 管道表格**：助手回答里的 `| col | col |` 表格直接渲染成真正的表格，不再原样留下管道字符。
- **输入框历史导航**：在空的输入框按 ↑ / ↓ 调出之前的提示词，类似 shell 历史。
- **默认开启整篇论文上下文固定**：默认勾选，关闭前会有警告；针对整篇论文的提问不再被旧的 PDF 选区不小心截窄。
- **前置块调试文件**：侧边栏 `调试` 开启时，每轮发给模型的 `[Paper full text]` 原文块同时落到 Zotero 数据目录下的本地文件中，Markdown 导出末尾附上路径，方便核对模型实际看到了什么。

## 安装

1. 从 [GitHub Releases](https://github.com/xuhan-rgb/zotero-ai-sidebar/releases/latest) 下载最新的 `zotero-ai-sidebar.xpi`。当前版本：[`v0.5.1`](https://github.com/xuhan-rgb/zotero-ai-sidebar/releases/tag/v0.5.1)。
2. 打开 Zotero 7、8 或 9。
3. 进入 `工具` → `插件`。
4. 点击齿轮图标，选择 `从文件安装插件…`。
5. 选择刚下载的 `.xpi` 文件，按提示重启 Zotero。

当前仓库只发布 `.xpi` 文件。简化后的发布流程不再发布 Zotero 自动更新清单（`update.json` / `update-beta.json`）。

## 配置

在 Zotero 中打开 AI Sidebar 设置，至少配置一个模型预设：

- 提供商：`anthropic` 或 `openai`
- API Key：保存在本地 Zotero 偏好中
- Base URL：官方端点或任何 OpenAI 兼容端点
- 模型：该端点支持的任意模型 ID
- Max tokens / 工具循环上限：本地的安全与输出长度控制

PDF 逐句翻译可在插件设置的“翻译”区域调整：

- 触发方式：单击或双击句子触发
- 浮层显示：紧凑 / 自适应尺寸，可显示在句子上方或下方
- 上下文范围：仅翻译当前句，或附带本段 / 本页上下文
- 句子导航：默认 `Enter` 跳到下一句，`Shift+Enter` 返回上一句

请勿在本仓库中硬编码个人 API Key、Base URL 或私有模型 ID。

## 功能特性

### 对话与界面

- **Zotero 内置 AI 对话**：直接在专属侧边栏与当前论文对话，无需离开 Zotero。
- **多提供商可配置**：通过 Zotero 本地偏好支持 Anthropic、OpenAI 以及任何 OpenAI 兼容端点。账号预设支持连通性测试，可为每个预设配置独立的模型列表并通过底部切换器快速切换。
- **快捷提示词与 Slash 命令**：在输入框旁边可自定义提示词按钮，并内置 `/arxiv-search`、`/web-search` 等 slash 命令，这些命令会被展开成给模型的明确指令。
- **Markdown 输出**：渲染标题、列表、代码块、引用、链接、思考/上下文块，以及工具调用轨迹。
- **选区上下文条**：PDF 有选中文本时，输入框上方会显示下一轮是 `只看选区` 还是 `选区 + 全文`，并提供本轮全文覆盖和选区预览。
- **可定制聊天界面**：用户和 AI 的昵称、头像（emoji 或图片 URL）均可自定义，每条消息的操作按钮位置和布局也可配置。
- **干净 / 调试两种复制模式**：将对话以 Markdown 复制时，普通导出包含论文介绍、对话和当轮 PDF 选区；调试模式额外附带工具上下文、PDF 片段、模型输入顺序和思考过程。

### PDF 与论文研究工具

- **由模型驱动的 Zotero 工具**：使用 Codex 风格的工具循环；不靠本地关键词/正则的意图判定来决定该把哪些 PDF 内容塞给模型。
- **PDF 上下文工具**：当前条目元信息、批注、PDF 全文检索、PDF 区间阅读、PDF 全文阅读，以及划选文本作为上下文。
- **选区原文溯源**：选中的 PDF 原文会保留在对话气泡和 Markdown 导出中；当 Zotero 提供定位信息时，可一键跳回 PDF 原选区。
- **图像上下文**：可以附带截图或图片，让模型分析图表、界面状态或 PDF 截图。
- **可自定义注释颜色规则**：可编辑模型写入 PDF 注释时使用的自然语言色彩规则，默认把 Zotero 的六种预设 hex 颜色映射到论文阅读常用类别（背景、问题、方法、数据集、结果等）。
- **arXiv 论文工具**：内置 `paper_search_arxiv` 和 `paper_fetch_arxiv_fulltext`，模型可按需检索 arXiv 并抓取全文。

### 笔记

- **面板内笔记编辑器**：在对话旁打开笔记列，直接就地编辑 Zotero 的富文本笔记，并提供 assistant 写入笔记的工具。
- **模型主动写入笔记**：模型也可以自行调用 `zotero_append_to_note`，把助手输出追加到当前条目的子笔记中，没有子笔记时会自动创建。
- **按当前光标导入片段**：选中一段助手回答后右键 `导入笔记`，会优先插入到当前 Zotero 笔记光标处，而不是固定追加到末尾。
- **稳定恢复笔记位置**：写入笔记后会恢复原来的滚动位置 / 鼠标锚点 / 光标位置，避免跳回笔记最开头。
- **返回 PDF 原选区**：写入笔记的块和助手上下文标签会带 `查看原选区` 跳转，方便从笔记或对话回到触发回答的 PDF 原文。

### 翻译

- **PDF 逐句翻译模式**：在 PDF Reader 中打开 `译` 模式，点击句子即可在原文旁显示译文，并可用 `Enter` / `Shift+Enter` 切换下一句 / 上一句。

### 同步与配置

- **配置备份与恢复**：把账号预设、显示设置、快捷提示词、联网/MCP 设置打包为一个 JSON 文件，可导出 / 导入。
- **WebDAV 云同步**：将设置、快捷提示词、翻译设置以及选中文本 / 注释引用，通过单个 `state.json` 快照推送到 / 拉取自任意 WebDAV 端点（如坚果云）。
- **对话和翻译缓存本地保存**：对话历史和逐句翻译缓存保存在 Zotero 本地数据 / profile 目录下，不会被插件的 WebDAV 同步上传。
- **本地优先**：API Key、Base URL、模型名以及私有提供商配置都保存在 Zotero 偏好里，不写进源代码。

## 总体架构

```mermaid
flowchart TB
    User([你])

    subgraph UI[Zotero 主窗口]
        direction LR
        Side[AI 侧边栏]
        PDF[PDF Reader]
        Note[笔记编辑器]
        Side --> PDF
        Side --> Note
    end

    subgraph Local[本地数据边界]
        direction LR
        Core[(Zotero 库<br/>题录 + Zotero 注释)]
        Files[(PDF 附件文件<br/>storage/*)]
        PluginState[(插件同步状态<br/>设置 / 提示词 / 引用)]
        Cache[(仅本地缓存<br/>对话 + 翻译)]
    end

    subgraph Runtime[运行时集成]
        direction LR
        Provider[LLM 提供商 API<br/>OpenAI / Anthropic / 兼容端点]
        Tools[本地 AgentTool<br/>可选自动化]
    end

    subgraph Cloud[云端同步目标]
        direction LR
        ZoteroOrg[(zotero.org<br/>元数据同步)]
        FileDAV[(WebDAV<br/>Zotero File Sync)]
        PluginDAV[(插件 WebDAV<br/>state.json)]
    end

    User -->|提问 / 选区 / 截图| Side
    Side <-->|HTTPS| Provider
    Side -->|工具| Tools
    Tools --> Core
    Side --> Cache
    Side --> PluginState
    Core --- Files

    Core -.题录 + Zotero 注释.-> ZoteroOrg
    Files -.附件同步.-> FileDAV
    PluginState -.推送 / 拉取.-> PluginDAV

    classDef actor fill:#fff7ed,stroke:#fb923c,color:#7c2d12,stroke-width:1px;
    classDef zotero fill:#eef2ff,stroke:#818cf8,color:#312e81,stroke-width:1px;
    classDef local fill:#ecfeff,stroke:#06b6d4,color:#164e63,stroke-width:1px;
    classDef runtime fill:#f5f3ff,stroke:#a78bfa,color:#4c1d95,stroke-width:1px;
    classDef cloud fill:#f0fdf4,stroke:#22c55e,color:#14532d,stroke-width:1px;
    class User actor;
    class Side,PDF,Note zotero;
    class Core,Files,PluginState,Cache local;
    class Provider,Tools runtime;
    class ZoteroOrg,FileDAV,PluginDAV cloud;
    style UI fill:#f8fafc,stroke:#c7d2fe,stroke-width:1px
    style Local fill:#ecfeff,stroke:#67e8f9,stroke-width:1px
    style Runtime fill:#faf5ff,stroke:#d8b4fe,stroke-width:1px
    style Cloud fill:#f0fdf4,stroke:#86efac,stroke-width:1px
```

### 三层云同步分工

```mermaid
flowchart LR
    subgraph Local[本机]
        direction TB
        Lib[(Zotero 库元数据<br/>题录 + Zotero 注释)]
        Storage[Zotero 附件文件<br/>storage/*]
        Plugin[插件同步状态<br/>设置 / 提示词 / 选中文本或注释引用]
        LocalState[仅本地状态<br/>对话历史 / 翻译缓存<br/>不会被插件同步上传]
    end
    subgraph Cloud[云端]
        direction TB
        ZS[zotero.org<br/>元数据同步]
        WD1[坚果云 WebDAV<br/>Zotero File Sync 写入]
        WD2[插件 WebDAV 命名空间<br/>插件状态快照]
        NoCloud[无云端副本]
    end
    Lib <-->|元数据同步| ZS
    Storage <-->|文件同步| WD1
    Plugin <-->|推送 / 拉取| WD2
    LocalState -.不上传.-> NoCloud

    classDef local fill:#ecfeff,stroke:#06b6d4,color:#164e63,stroke-width:1px;
    classDef cloud fill:#f0fdf4,stroke:#22c55e,color:#14532d,stroke-width:1px;
    classDef blocked fill:#fff1f2,stroke:#fb7185,color:#881337,stroke-width:1px,stroke-dasharray:4 3;
    class Lib,Storage,Plugin,LocalState local;
    class ZS,WD1,WD2 cloud;
    class NoCloud blocked;
    style Local fill:#ecfeff,stroke:#67e8f9,stroke-width:1px
    style Cloud fill:#f8fafc,stroke:#cbd5e1,stroke-width:1px
```

## 开发

安装依赖：

```bash
npm install
```

运行测试：

```bash
npm test
```

本地构建 XPI：

```bash
npm run build
```

构建产物在 `.scaffold/build/`。本地 `.xpi` 文件已被 `.gitignore` 忽略，不要提交。

## 发布

`/auto-commit` 完成版本号更新后，运行 `npm run release:xpi` 即可一步完成打 tag、推送、GitHub Actions 构建并发布 Release。`--republish`、显式 tag 等参数及校验细节见 [`docs/RELEASE.md`](docs/RELEASE.md)。

## 设计原则

项目特定的修改指引（Codex 风格 agent、Claudian 风格对话 UI、Better Notes 风格笔记编辑、不可触碰的红线）都在 [`CLAUDE.md`](CLAUDE.md)。本地工具 / Web Search / MCP 的使用边界见 [`docs/TOOLS_AND_MCP.md`](docs/TOOLS_AND_MCP.md)。

## 许可证

AGPL-3.0-or-later。
