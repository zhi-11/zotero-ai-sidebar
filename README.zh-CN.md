# Zotero Sentence Translator

[English](README.md) | [中文](README.zh-CN.md)

专注的 Zotero PDF 逐句翻译插件，支持一键标注。点击 PDF 中的句子即可查看 AI 翻译，并通过色块一键保存为彩色高亮标注。

## 功能

- **点击翻译** — 在 PDF 阅读器中点击任意句子，浮窗显示 AI 翻译。用 `Enter` / `Shift+Enter` 逐句浏览。
- **彩色标注** — 翻译完成后，点击色块即可将句子保存为对应颜色的 PDF 高亮。12 种预设颜色对应常见研究分类（方法、结果、背景、术语等），可在设置中自定义。
- **左右优先定位** — 针对双栏论文，翻译浮窗优先显示在句子旁边（自动模式：右侧 → 左侧 → 下方），不遮挡阅读。
- **智能断句** — 属名缩写（如 `A. japonicus`）自动识别，不会被误断。分类学常用缩写（`sp.` `spp.` `var.` `cf.` `aff.`）可配置排除。
- **自带模型** — 支持 Anthropic、OpenAI 及兼容接口，API Key 本地存储在 Zotero 偏好设置中。
- **字体大小可调** — 翻译框字体 10-28px 自由调节。
- **快捷键可配** — 切换翻译模式的快捷键可自定义，带「记录」按钮，Alt+T 作为后备。

## 安装

1. 从 [GitHub Releases](https://github.com/xuhan-rgb/zotero-ai-sidebar/releases/latest) 下载最新 `.xpi`。
2. 打开 Zotero 7/8/9。
3. `工具` → `插件` → 齿轮图标 → `从文件安装插件`。
4. 选择下载的 `.xpi`，按提示重启 Zotero。

## 配置

在 Zotero 插件设置中至少配置一个模型账号：

- Provider：`anthropic` 或 `openai`
- API Key：本地存储
- Base URL：官方或兼容地址
- Model：任意支持的模型 ID

翻译设置：

- **触发方式**：单击或双击翻译
- **结果位置**：自动（优先左右）/ 右侧 / 左侧 / 上方 / 下方
- **翻译框大小**：紧凑或自适应
- **上下文**：仅本句 / 本段 / 整页
- **快捷键**：Enter 下一句，Shift+Enter 上一句
- **字体大小**：10-28px（默认 14）
- **翻译模式快捷键**：可自定义，留空仅用 Alt+T
- **断句例外词**：不会被句号断开的词（如 `sp` `spp`）
- **标注颜色**：12 种可自定义颜色预设

## 开发

```bash
npm install
npm run build
```

构建输出在 `.scaffold/build/`。

## 许可

AGPL-3.0-or-later。
