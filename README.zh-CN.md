# Zotero AI Sidebar

[English](README.md) | [中文](README.zh-CN.md)

Zotero AI Sidebar 是一个适配 Zotero 7/8/9 的插件，会在条目面板 / PDF 阅读流程旁边加上一个 AI 对话面板。它被设计成一个轻量的论文研究 agent：由模型自己决定何时去查看当前 Zotero 条目、批注、PDF 片段、PDF 全文、截图，或通过插件暴露的 Zotero 工具写入批注。

📖 **[完整使用指南（HTML 网页）](docs/usage.html)** —— 含安装、配置、Slash 命令、云同步、灾备的分步说明

## 亮点

- **Zotero 内置 AI 对话** —— 专属侧边栏始终知道你正在读哪一篇论文。
- **PDF 逐句翻译模式** —— 点击句子即可在原文旁显示译文，`Enter` / `Shift+Enter` 在句子间穿行。
- **自带模型自由切换** —— Anthropic、OpenAI 或任意 OpenAI 兼容端点，全部在 Zotero 偏好里本地配置。
- **读 PDF、写笔记和注释** —— 由模型驱动的工具覆盖全文、批注、截图，以及子笔记的写入。
- **WebDAV 云同步** —— 用一个 `state.json` 快照同步对话、设置、提示词以及指定论文的注释。

## 安装

1. 从 GitHub Releases 下载最新的 `zotero-ai-sidebar.xpi`。
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
- **可定制聊天界面**：用户和 AI 的昵称、头像（emoji 或图片 URL）均可自定义，每条消息的操作按钮位置和布局也可配置。
- **干净 / 调试两种复制模式**：将对话以 Markdown 复制时，可选择只复制论文介绍 + 对话，或额外附带工具上下文、PDF 片段和思考过程，便于调试。

### PDF 与论文研究工具

- **由模型驱动的 Zotero 工具**：使用 Codex 风格的工具循环；不靠本地关键词/正则的意图判定来决定该把哪些 PDF 内容塞给模型。
- **PDF 上下文工具**：当前条目元信息、批注、PDF 全文检索、PDF 区间阅读、PDF 全文阅读，以及划选文本作为上下文。
- **图像上下文**：可以附带截图或图片，让模型分析图表、界面状态或 PDF 截图。
- **可自定义注释颜色规则**：可编辑模型写入 PDF 注释时使用的自然语言色彩规则，默认把 Zotero 的六种预设 hex 颜色映射到论文阅读常用类别（背景、问题、方法、数据集、结果等）。
- **arXiv 论文工具**：内置 `paper_search_arxiv` 和 `paper_fetch_arxiv_fulltext`，模型可按需检索 arXiv 并抓取全文。

### 笔记

- **面板内笔记编辑器**：在对话旁打开笔记列，直接就地编辑 Zotero 的富文本笔记，并提供 assistant 写入笔记的工具。
- **模型主动写入笔记**：模型也可以自行调用 `zotero_append_to_note`，把助手输出追加到当前条目的子笔记中，没有子笔记时会自动创建。

### 翻译

- **PDF 逐句翻译模式**：在 PDF Reader 中打开 `译` 模式，点击句子即可在原文旁显示译文，并可用 `Enter` / `Shift+Enter` 切换下一句 / 上一句。

### 同步与配置

- **配置备份与恢复**：把账号预设、显示设置、快捷提示词、联网/MCP 设置打包为一个 JSON 文件，可导出 / 导入。
- **WebDAV 云同步**：将对话、设置、快捷提示词以及指定论文的注释，通过单个 `state.json` 快照推送到 / 拉取自任意 WebDAV 端点（如坚果云），并使用跨机器稳定的线程标识，让对话在不同机器之间同步。
- **本地优先**：API Key、Base URL、模型名以及私有提供商配置都保存在 Zotero 偏好里，不写进源代码。

## 总体架构

```mermaid
flowchart LR
    subgraph Zotero[Zotero 主窗口]
        PDF[PDF Reader]
        Note[笔记编辑器]
        Side[AI 侧边栏]
    end
    User([你]) -->|提问 / 选区 / 截图| Side
    Side -->|工具调用| Tools[本地 AgentTool]
    Tools -->|读 / 写| Zotero
    Side <-->|HTTPS| Provider[OpenAI / Anthropic /<br/>OpenAI 兼容端点]
    Side -.对话 / 设置 / 注释.-> WebDAV[(坚果云 WebDAV)]
    Zotero -.PDF 文件.-> WebDAV
    Zotero -.题录元数据.-> ZoteroOrg[(zotero.org)]
```

### 三层云同步分工

```mermaid
flowchart TB
    subgraph Local[本机]
        Lib[(Zotero 库 + 注释)]
        Storage[storage/*.pdf]
        Plugin[插件状态<br/>对话 / 设置 / 提示词]
    end
    subgraph Cloud[云端]
        ZS[zotero.org<br/>免费 300MB]
        WD1[坚果云 WebDAV<br/>Zotero File Sync 写入]
        WD2[坚果云 WebDAV<br/>本插件写入]
    end
    Lib <-->|metadata sync| ZS
    Storage <-->|file sync| WD1
    Plugin <-->|push / pull| WD2
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
