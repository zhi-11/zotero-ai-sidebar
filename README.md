# Zotero Sentence Translator

[English](README.md) | [中文](README.zh-CN.md)

A focused Zotero plugin for PDF sentence-by-sentence translation with rich annotation. Click a sentence in the PDF reader, see the translation in a floating overlay, and save it as a color-coded PDF highlight.

## What you can do

- **Click-to-translate** — click any sentence in the PDF reader and see the AI translation in a floating overlay. Walk through the paper with `Enter` / `Shift+Enter`.
- **Color-coded annotation** — after translation, click a color swatch to save the sentence as a PDF highlight with that color. 12 preset colors map to common research categories (method, result, background, terminology, etc.), fully customizable in settings.
- **Left/right overlay positioning** — for dual-column papers, the translation overlay prefers to appear beside the sentence (auto: right → left → below), keeping your reading flow uninterrupted.
- **Smart sentence splitting** — genus abbreviations like `A. japonicus` are auto-detected and won'\''t break sentences. Configurable exclusion list for taxonomic abbreviations (`sp.`, `spp.`, `var.`, `cf.`, `aff.`).
- **Bring your own model** — Anthropic, OpenAI, or any OpenAI-compatible endpoint; configured locally in Zotero preferences.
- **Configurable font size** — adjust the translation overlay font size (10-28px).
- **Customizable toggle shortcut** — set your own keyboard shortcut to toggle translation mode, with a record button and Alt+T fallback.

## Install

1. Download the latest `.xpi` from [GitHub Releases](https://github.com/xuhan-rgb/zotero-ai-sidebar/releases/latest).
2. Open Zotero 7, 8, or 9.
3. Go to `Tools` → `Plugins`.
4. Click the gear icon and choose `Install Plugin From File...`.
5. Select the downloaded `.xpi` file and restart Zotero if prompted.

## Configuration

Open plugin settings in Zotero and configure at least one model preset:

- Provider: `anthropic` or `openai`
- API key: stored locally in Zotero preferences
- Base URL: official endpoint or an OpenAI-compatible endpoint
- Model: any model ID supported by that endpoint

Then configure the translation section:

- **Trigger mode**: single-click or double-click
- **Overlay position**: auto (prefers right side), left, right, above, below
- **Overlay size**: compact or adaptive
- **Context**: sentence only, paragraph, or full page
- **Shortcuts**: `Enter` for next sentence, `Shift+Enter` for previous
- **Font size**: 10-28px (default 14)
- **Toggle shortcut**: configurable, Alt+T as fallback
- **Sentence exceptions**: words that won'\''t break sentences (e.g. `sp`, `spp`)
- **Annotation colors**: 12 customizable color presets with labels

## Features

### Translation

- Sentence detection from PDF text layer with confidence-based location
- AI-powered translation with configurable thinking effort and context window
- Translation cache for instant re-display of previously translated sentences
- Keyboard navigation: `Enter` / `Shift+Enter` to walk through sentences

### Annotation

- Save translations as PDF highlights with one click
- 12 default color presets: highlight, background, method, result, terminology, vocabulary, question, author view, figure/table, literature, data
- Fully customizable colors and labels in settings
- Optional: save the translation text as the highlight comment

### Overlay

- Floating overlay beside or above/below the sentence
- Auto-positioning: tries right side first, then left, then below
- Configurable width and font size
- Clean minimal design with color swatch palette

### Sentence splitting

- Auto-detection of genus abbreviations (`A. japonicus`, `E. coli`)
- Configurable exception list for field-specific abbreviations
- Acronym handling (`U.S.A.`, `e.g.`, `i.e.`)

## Development

```bash
npm install
npm run build
```

The build output is written to `.scaffold/build/`.

## License

AGPL-3.0-or-later.
