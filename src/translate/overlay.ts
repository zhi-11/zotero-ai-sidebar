import type {
  AnnotationColorPreset,
  TranslateOverlayMode,
  TranslateOverlayPosition,
  TranslateOverlaySize,
} from "../settings/types";
import type { PdfPageContent, PdfRect } from "../context/pdf-locator";
import { logTranslateDebug } from "./debug-log";
import type { AnalysisBlock } from "./translator";

export interface OverlayHandle {
  el: HTMLElement;
  setText(text: string): void;
  appendText(delta: string): void;
  setDone(): void;
  setError(message: string): void;
  setStatus(message: string): void;
  setStatusLabel(message: string): void;
  setPaletteEnabled(enabled: boolean): void;
  setAnalysis(blocks: AnalysisBlock[]): void;
  setExplanation(text: string): void;
  setMode(mode: TranslateOverlayMode): void;
  destroy(): void;
}

export interface OverlayActions {
  onPrev?: () => void;
  onNext?: () => void;
  onRetry?: () => void;
  onModeSwitch?: (mode: TranslateOverlayMode) => void;
  onSaveColor?: (preset: AnnotationColorPreset) => void;
  onClose: () => void;
  hint: string;
  colors?: AnnotationColorPreset[];
}

export interface MountOverlayInput {
  iframeDoc: Document;
  pageEl: HTMLElement;
  rects: PdfRect[];
  pageContent: PdfPageContent;
  position: TranslateOverlayPosition;
  size: TranslateOverlaySize;
  actions: OverlayActions;
  initialText?: string;
  fontSize?: number;
  analysisEnglishFontSize?: number;
  analysisChineseFontSize?: number;
  showTranslationInAnalysis?: boolean;
  initialMode?: TranslateOverlayMode;
  enabledModes?: readonly TranslateOverlayMode[];
}

export function mountOverlay(input: MountOverlayInput): OverlayHandle {
  const {
    iframeDoc,
    pageEl,
    rects,
    pageContent,
    position,
    size,
    actions,
    initialText,
    fontSize = 14,
    analysisEnglishFontSize = 12,
    analysisChineseFontSize = 11,
    showTranslationInAnalysis = true,
    initialMode = "translate",
    enabledModes = ["translate", "explain", "analyze"],
  } = input;

  ensureStyle(iframeDoc);
  removeStaleTranslateDom(iframeDoc);
  const popupGuard = mountSelectionPopupGuard(iframeDoc);
  const highlights = mountHighlights(iframeDoc, pageEl, rects, pageContent);

  const el = iframeDoc.createElement("div");
  el.className = "zai-translate-overlay";
  el.setAttribute("data-position", position);
  el.setAttribute("data-size", size);

  const meta = iframeDoc.createElement("div");
  meta.className = "zai-translate-overlay__meta";
  const modeBar = iframeDoc.createElement("div");
  modeBar.className = "zai-translate-overlay__mode-bar";
  const modes: Array<[TranslateOverlayMode, string]> = [["translate", "简译"]];
  if (enabledModes.includes("explain")) modes.push(["explain", "详解"]);
  if (enabledModes.includes("analyze")) modes.push(["analyze", "解析"]);
  for (const [mode, label] of modes) {
    const tab = iframeDoc.createElement("button");
    tab.type = "button";
    tab.className =
      "zai-translate-overlay__mode-tab" +
      (initialMode === mode ? " zai-translate-overlay__mode-tab--active" : "");
    tab.textContent = label;
    tab.dataset.mode = mode;
    modeBar.appendChild(tab);
  }
  meta.appendChild(modeBar);
  const status = iframeDoc.createElement("span");
  status.className = "zai-translate-overlay__status";
  status.textContent = "● 翻译中…";
  meta.appendChild(status);
  el.appendChild(meta);

  const body = iframeDoc.createElement("div");
  body.className = "zai-translate-overlay__body";
  if (initialText) body.textContent = initialText;
  el.appendChild(body);

  const actionsRow = iframeDoc.createElement("div");
  actionsRow.className = "zai-translate-overlay__actions";
  actionsRow.appendChild(
    makeBtn(
      iframeDoc,
      "↻",
      "刷新当前模式（忽略缓存并覆盖旧结果）",
      actions.onRetry,
    ),
  );
  actionsRow.appendChild(makeBtn(iframeDoc, "▲", "上一句", actions.onPrev));
  actionsRow.appendChild(makeBtn(iframeDoc, "▼", "下一句", actions.onNext));
  const hintEl = iframeDoc.createElement("span");
  hintEl.className = "zai-translate-overlay__hint";
  hintEl.textContent = actions.hint;
  actionsRow.appendChild(hintEl);
  actionsRow.appendChild(
    makeBtn(iframeDoc, "✕", "关闭 (Esc)", actions.onClose),
  );
  el.appendChild(actionsRow);

  const palette = iframeDoc.createElement("div");
  palette.className = "zai-translate-overlay__palette";
  for (const preset of actions.colors ?? []) {
    const swatch = iframeDoc.createElement("button");
    swatch.type = "button";
    swatch.className = "zai-translate-overlay__swatch";
    swatch.style.backgroundColor = preset.color;
    swatch.title = `${preset.label} ${preset.color}`;
    swatch.setAttribute("aria-label", `${preset.label} ${preset.color}`);
    swatch.addEventListener("click", (ev) => {
      ev.stopPropagation();
      actions.onSaveColor?.(preset);
    });
    palette.appendChild(swatch);
  }
  if (palette.childElementCount) el.appendChild(palette);

  body.classList.toggle(
    "zai-translate-overlay__body--analysis",
    initialMode === "analyze",
  );
  body.classList.toggle(
    "zai-translate-overlay__body--explain",
    initialMode === "explain",
  );
  el.classList.toggle(
    "zai-translate-overlay--analysis",
    initialMode === "analyze",
  );
  el.classList.toggle(
    "zai-translate-overlay--explain",
    initialMode === "explain",
  );

  el.style.visibility = "hidden";
  (iframeDoc.body ?? pageEl).appendChild(el);

  let destroyed = false;
  let positionFrame = 0;
  const win = iframeDoc.defaultView;
  const positionNow = () => {
    if (destroyed) return;
    if (positionFrame && win) {
      win.cancelAnimationFrame(positionFrame);
      positionFrame = 0;
    }
    positionOverlay(
      el,
      pageEl,
      rects,
      pageContent,
      position,
      size,
      fontSize,
      analysisEnglishFontSize,
      analysisChineseFontSize,
    );
  };
  const schedulePosition = () => {
    if (destroyed) return;
    if (!win) {
      positionNow();
      return;
    }
    if (positionFrame) return;
    positionFrame = win.requestAnimationFrame(() => {
      positionFrame = 0;
      positionOverlay(
        el,
        pageEl,
        rects,
        pageContent,
        position,
        size,
        fontSize,
        analysisEnglishFontSize,
        analysisChineseFontSize,
      );
    });
  };
  positionNow();
  win?.addEventListener("scroll", schedulePosition, true);
  win?.addEventListener("resize", schedulePosition);
  body.addEventListener("toggle", schedulePosition, true);

  let currentMode = initialMode;
  let cachedTranslationText = "";
  let cachedAnalysisBlocks: AnalysisBlock[] | null = null;
  let cachedExplanationText = "";

  modeBar.addEventListener("click", (ev) => {
    const tab = (ev.target as Element | null)?.closest?.(
      ".zai-translate-overlay__mode-tab",
    ) as HTMLElement | null;
    const mode = tab?.dataset.mode as TranslateOverlayMode | undefined;
    if (!mode || mode === currentMode) return;
    actions.onModeSwitch?.(mode);
  });

  return {
    el,
    setText(text) {
      cachedTranslationText = text;
      if (
        currentMode === "analyze" &&
        cachedAnalysisBlocks &&
        showTranslationInAnalysis
      ) {
        renderAnalysisBlocks(
          body,
          cachedAnalysisBlocks,
          iframeDoc,
          cachedTranslationText,
        );
        status.textContent = "● 已完成";
        schedulePosition();
        return;
      }
      if (currentMode === "explain" && cachedExplanationText) {
        renderExplanation(
          body,
          cachedExplanationText,
          iframeDoc,
          cachedTranslationText,
        );
        status.textContent = "● 已完成";
        schedulePosition();
        return;
      }
      if (currentMode !== "translate") return;
      body.classList.remove(
        "zai-translate-overlay__body--status",
        "zai-translate-overlay__body--analysis",
        "zai-translate-overlay__body--explain",
      );
      body.textContent = text;
      status.textContent = "● 已完成";
      schedulePosition();
    },
    appendText(delta) {
      if (currentMode !== "translate") return;
      if (body.classList.contains("zai-translate-overlay__body--status")) {
        body.textContent = "";
        body.classList.remove("zai-translate-overlay__body--status");
      }
      body.textContent = (body.textContent ?? "") + delta;
      schedulePosition();
    },
    setDone() {
      if (currentMode === "translate") status.textContent = "● 已完成";
      schedulePosition();
    },
    setError(message) {
      body.classList.remove(
        "zai-translate-overlay__body--status",
        "zai-translate-overlay__body--analysis",
        "zai-translate-overlay__body--explain",
      );
      body.textContent = `⚠️ ${message}`;
      status.textContent =
        currentMode === "analyze"
          ? "● 分析失败"
          : currentMode === "explain"
            ? "● 详解失败"
            : "● 翻译失败";
      el.classList.add("zai-translate-overlay--error");
      schedulePosition();
    },
    setStatus(message) {
      body.classList.add("zai-translate-overlay__body--status");
      body.textContent = message;
      status.textContent = message.includes("翻译")
        ? "● 翻译中…"
        : message.includes("分析")
          ? "● 分析中…"
          : message.includes("详解")
            ? "● 详解中…"
            : "● 等待中…";
      schedulePosition();
    },
    setStatusLabel(message) {
      status.textContent = message;
      schedulePosition();
    },
    setPaletteEnabled(enabled) {
      palette
        .querySelectorAll<HTMLButtonElement>(".zai-translate-overlay__swatch")
        .forEach((button: HTMLButtonElement) => {
          button.disabled = !enabled;
        });
    },
    setAnalysis(blocks) {
      cachedAnalysisBlocks = blocks;
      if (currentMode !== "analyze") return;
      renderAnalysisBlocks(
        body,
        blocks,
        iframeDoc,
        showTranslationInAnalysis
          ? cachedTranslationText || undefined
          : undefined,
      );
      status.textContent = "● 已完成";
      el.classList.remove("zai-translate-overlay--error");
      schedulePosition();
    },
    setExplanation(text) {
      cachedExplanationText = text;
      if (currentMode !== "explain") return;
      renderExplanation(
        body,
        text,
        iframeDoc,
        cachedTranslationText || undefined,
      );
      status.textContent = "● 已完成";
      el.classList.remove("zai-translate-overlay--error");
      schedulePosition();
    },
    setMode(mode) {
      currentMode = mode;
      el.classList.remove("zai-translate-overlay--error");
      modeBar
        .querySelectorAll<HTMLElement>(".zai-translate-overlay__mode-tab")
        .forEach((tab: HTMLElement) => {
          tab.classList.toggle(
            "zai-translate-overlay__mode-tab--active",
            tab.dataset.mode === mode,
          );
        });
      body.classList.toggle(
        "zai-translate-overlay__body--analysis",
        mode === "analyze",
      );
      body.classList.toggle(
        "zai-translate-overlay__body--explain",
        mode === "explain",
      );
      el.classList.toggle(
        "zai-translate-overlay--analysis",
        mode === "analyze",
      );
      el.classList.toggle("zai-translate-overlay--explain", mode === "explain");

      if (mode === "analyze") {
        if (cachedAnalysisBlocks) {
          renderAnalysisBlocks(
            body,
            cachedAnalysisBlocks,
            iframeDoc,
            showTranslationInAnalysis
              ? cachedTranslationText || undefined
              : undefined,
          );
        } else {
          body.classList.add("zai-translate-overlay__body--status");
          body.textContent = "分析中…";
          status.textContent = "● 分析中…";
        }
      } else if (mode === "explain") {
        if (cachedExplanationText) {
          renderExplanation(
            body,
            cachedExplanationText,
            iframeDoc,
            cachedTranslationText || undefined,
          );
        } else {
          body.classList.add("zai-translate-overlay__body--status");
          body.textContent = "详解中…";
          status.textContent = "● 详解中…";
        }
      } else if (cachedTranslationText) {
        body.classList.remove(
          "zai-translate-overlay__body--analysis",
          "zai-translate-overlay__body--explain",
          "zai-translate-overlay__body--status",
        );
        body.textContent = cachedTranslationText;
        status.textContent = "● 已完成";
      } else {
        body.classList.add("zai-translate-overlay__body--status");
        body.textContent = "翻译中…";
        status.textContent = "● 翻译中…";
      }
      schedulePosition();
    },
    destroy() {
      destroyed = true;
      if (positionFrame && win) win.cancelAnimationFrame(positionFrame);
      win?.removeEventListener("scroll", schedulePosition, true);
      win?.removeEventListener("resize", schedulePosition);
      el.remove();
      for (const highlight of highlights) highlight.remove();
      popupGuard.destroy();
    },
  };
}

const ROLE_COLORS: Record<string, string> = {
  主语: "rgba(74, 140, 247, 0.14)",
  谓语: "rgba(95, 178, 54, 0.16)",
  系动词: "rgba(95, 178, 54, 0.16)",
  宾语: "rgba(241, 152, 55, 0.16)",
  表语: "rgba(241, 152, 55, 0.16)",
  定语: "rgba(166, 110, 238, 0.14)",
  状语: "rgba(153, 153, 153, 0.14)",
  补语: "rgba(230, 86, 238, 0.14)",
  同位语: "rgba(68, 26, 225, 0.12)",
  插入语: "rgba(210, 216, 226, 0.18)",
  连接词: "rgba(153, 153, 153, 0.10)",
  标点: "rgba(200, 200, 200, 0.06)",
};

function renderAnalysisBlocks(
  body: HTMLElement,
  blocks: AnalysisBlock[],
  doc: Document,
  translation?: string,
): void {
  body.classList.remove("zai-translate-overlay__body--status");
  body.innerHTML = "";
  const wrapper = doc.createElement("div");
  wrapper.className = "zai-analysis-blocks";
  renderAnalysisNodes(wrapper, blocks, doc);
  body.appendChild(wrapper);
  appendSimpleTranslation(body, doc, translation);
}

function renderAnalysisNodes(
  parent: HTMLElement,
  blocks: AnalysisBlock[],
  doc: Document,
): void {
  for (const block of blocks) {
    if (block.role === "标点") {
      const punctText = [",", ".", ";", ":", "!", "?"].includes(block.text)
        ? `${block.text} `
        : block.text;
      const token = doc.createElement("span");
      token.className = "zai-analyze-tok";
      const hiddenRole = doc.createElement("span");
      hiddenRole.className = "zai-analyze-tok__role";
      hiddenRole.style.visibility = "hidden";
      hiddenRole.textContent = " ";
      const text = doc.createElement("span");
      text.className = "zai-analyze-tok__text";
      text.style.background = "transparent";
      text.textContent = punctText;
      token.append(hiddenRole, text);
      parent.appendChild(token);
      continue;
    }

    if (block.isClause && block.children) {
      const clause = doc.createElement("span");
      clause.className = "zai-analyze-clause";
      renderAnalysisNodes(clause, block.children, doc);
      parent.appendChild(clause);
      continue;
    }

    const token = doc.createElement("span");
    token.className = "zai-analyze-tok";
    const role = doc.createElement("span");
    role.className = "zai-analyze-tok__role";
    role.textContent = block.role;
    const text = doc.createElement("span");
    text.className = "zai-analyze-tok__text";
    text.style.background =
      ROLE_COLORS[block.role] || "rgba(200, 200, 200, 0.14)";
    text.textContent = block.text;
    token.append(role, text);
    if (block.meaning) {
      const meaning = doc.createElement("span");
      meaning.className = "zai-analyze-tok__meaning";
      meaning.textContent = block.meaning;
      token.appendChild(meaning);
    }
    parent.appendChild(token);
  }
}

function renderExplanation(
  body: HTMLElement,
  explanation: string,
  doc: Document,
  translation?: string,
): void {
  body.classList.remove("zai-translate-overlay__body--status");
  body.innerHTML = "";
  appendExplanationTranslation(body, doc, translation);
  const content = doc.createElement("div");
  content.className = "zai-explanation";
  renderMarkdown(content, explanation, doc);
  body.appendChild(content);
}

function appendExplanationTranslation(
  body: HTMLElement,
  doc: Document,
  translation?: string,
): void {
  if (!translation) return;
  const panel = doc.createElement("details");
  panel.className = "zai-explanation-translation";
  panel.open = true;

  const summary = doc.createElement("summary");
  summary.className = "zai-explanation-translation__summary";
  summary.textContent = "简译";
  summary.title = "点击折叠或展开简译";
  panel.appendChild(summary);

  const text = doc.createElement("div");
  text.className = "zai-explanation-translation__text";
  text.textContent = translation;
  panel.appendChild(text);
  body.appendChild(panel);
}

function renderMarkdown(
  container: HTMLElement,
  markdown: string,
  doc: Document,
): void {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index++;
      continue;
    }

    const fence = line.match(/^\s*```([\w-]*)\s*$/);
    if (fence) {
      const codeLines: string[] = [];
      index++;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? "")) {
        codeLines.push(lines[index] ?? "");
        index++;
      }
      if (index < lines.length) index++;
      const pre = doc.createElement("pre");
      const code = doc.createElement("code");
      if (fence[1]) code.className = `language-${fence[1]}`;
      code.textContent = codeLines.join("\n");
      pre.appendChild(code);
      container.appendChild(pre);
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const element = doc.createElement(`h${level}`);
      appendInlineMarkdown(element, heading[2] ?? "", doc);
      container.appendChild(element);
      index++;
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      index = appendMarkdownTable(container, lines, index, doc);
      continue;
    }

    const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const list = doc.createElement(unordered ? "ul" : "ol");
      const itemPattern = unordered
        ? /^\s*[-+*]\s+(.+)$/
        : /^\s*\d+[.)]\s+(.+)$/;
      while (index < lines.length) {
        const item = (lines[index] ?? "").match(itemPattern);
        if (!item) break;
        const li = doc.createElement("li");
        appendInlineMarkdown(li, item[1] ?? "", doc);
        list.appendChild(li);
        index++;
      }
      container.appendChild(list);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const quote = (lines[index] ?? "").match(/^\s*>\s?(.*)$/);
        if (!quote) break;
        quoteLines.push(quote[1] ?? "");
        index++;
      }
      const blockquote = doc.createElement("blockquote");
      appendInlineMarkdown(blockquote, quoteLines.join(" "), doc);
      container.appendChild(blockquote);
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      container.appendChild(doc.createElement("hr"));
      index++;
      continue;
    }

    const paragraphLines = [line.trim()];
    index++;
    while (index < lines.length && !isMarkdownBlockStart(lines, index)) {
      paragraphLines.push((lines[index] ?? "").trim());
      index++;
    }
    const paragraph = doc.createElement("p");
    appendInlineMarkdown(paragraph, paragraphLines.join(" "), doc);
    container.appendChild(paragraph);
  }
}

function isMarkdownBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  return (
    !line.trim() ||
    /^\s*```/.test(line) ||
    /^\s*#{1,6}\s+/.test(line) ||
    /^\s*[-+*]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line) ||
    isMarkdownTableStart(lines, index)
  );
}

function isMarkdownTableStart(lines: string[], index: number): boolean {
  const header = splitMarkdownTableRow(lines[index] ?? "");
  const divider = splitMarkdownTableRow(lines[index + 1] ?? "");
  return (
    header.length > 0 &&
    divider.length === header.length &&
    divider.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
  );
}

function appendMarkdownTable(
  container: HTMLElement,
  lines: string[],
  start: number,
  doc: Document,
): number {
  const table = doc.createElement("table");
  const head = doc.createElement("thead");
  const headRow = doc.createElement("tr");
  for (const value of splitMarkdownTableRow(lines[start] ?? "")) {
    const cell = doc.createElement("th");
    appendInlineMarkdown(cell, value.trim(), doc);
    headRow.appendChild(cell);
  }
  head.appendChild(headRow);
  table.appendChild(head);

  const body = doc.createElement("tbody");
  let index = start + 2;
  while (index < lines.length && (lines[index] ?? "").includes("|")) {
    const values = splitMarkdownTableRow(lines[index] ?? "");
    if (!values.length) break;
    const row = doc.createElement("tr");
    for (const value of values) {
      const cell = doc.createElement("td");
      appendInlineMarkdown(cell, value.trim(), doc);
      row.appendChild(cell);
    }
    body.appendChild(row);
    index++;
  }
  table.appendChild(body);
  container.appendChild(table);
  return index;
}

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.includes("|") ? trimmed.split("|") : [];
}

function appendInlineMarkdown(
  parent: HTMLElement,
  source: string,
  doc: Document,
): void {
  const pattern =
    /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > offset)
      parent.appendChild(doc.createTextNode(source.slice(offset, start)));
    const token = match[0];
    let element: HTMLElement;
    let text: string;
    if (token.startsWith("`")) {
      element = doc.createElement("code");
      text = token.slice(1, -1);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      element = doc.createElement("strong");
      text = token.slice(2, -2);
    } else if (token.startsWith("~~")) {
      element = doc.createElement("del");
      text = token.slice(2, -2);
    } else if (token.startsWith("[")) {
      const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      element = doc.createElement("a");
      text = link?.[1] ?? token;
      if (link?.[2]) {
        element.setAttribute("href", link[2]);
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noopener noreferrer");
      }
    } else {
      element = doc.createElement("em");
      text = token.slice(1, -1);
    }
    element.textContent = text;
    parent.appendChild(element);
    offset = start + token.length;
  }
  if (offset < source.length)
    parent.appendChild(doc.createTextNode(source.slice(offset)));
}

function appendSimpleTranslation(
  body: HTMLElement,
  doc: Document,
  translation?: string,
  showLabel = false,
  separatorPlacement: "before" | "after" = "before",
): void {
  if (!translation) return;
  const separator = doc.createElement("div");
  separator.className = "zai-analysis-translation-sep";
  if (separatorPlacement === "before") body.appendChild(separator);
  if (showLabel) {
    const label = doc.createElement("div");
    label.className = "zai-explanation__translation-label";
    label.textContent = "简译";
    body.appendChild(label);
  }
  const translationEl = doc.createElement("div");
  translationEl.className = "zai-analysis-translation";
  translationEl.textContent = translation;
  body.appendChild(translationEl);
  if (separatorPlacement === "after") body.appendChild(separator);
}

function removeStaleTranslateDom(doc: Document): void {
  doc
    .querySelectorAll(".zai-translate-overlay,.zai-translate-highlight")
    .forEach((node: Element) => node.remove());
}

export function mountSelectionPopupGuard(doc: Document): { destroy(): void } {
  const docs = relatedDocuments(doc);
  guardLog("mountSelectionPopupGuard", {
    docCount: docs.length,
    urls: docs.map(safeDocUrl),
  });
  for (const targetDoc of docs) {
    try {
      ensureSelectionPopupGuardStyle(targetDoc);
      targetDoc.documentElement?.classList.add(SELECTION_POPUP_GUARD_CLASS);
      guardLog("class added to documentElement", {
        url: safeDocUrl(targetDoc),
        hasClass: targetDoc.documentElement?.classList.contains(
          SELECTION_POPUP_GUARD_CLASS,
        ),
      });
    } catch (err) {
      guardLog("failed to add guard class to doc", {
        url: safeDocUrl(targetDoc),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // CSS-class approach can fail if `.selection-popup` is rendered in a doc
  // we cannot reach (cross-origin, shadow DOM, late-mount). Add a hard
  // MutationObserver that watches every reachable doc and hides every
  // `.selection-popup` it finds — both already-present and newly-inserted.
  const observers: MutationObserver[] = [];
  // Duck-type rather than `instanceof HTMLElement`: in the chrome bootstrap
  // realm, `HTMLElement` is undefined, so `instanceof` throws ReferenceError
  // when the observer callback runs.
  const hidePopup = (el: Element) => {
    try {
      const styled = el as Element & { style?: CSSStyleDeclaration };
      if (styled.style?.setProperty) {
        styled.style.setProperty("visibility", "hidden", "important");
        styled.style.setProperty("pointer-events", "none", "important");
      } else {
        el.setAttribute(
          "style",
          "visibility: hidden !important; pointer-events: none !important;",
        );
      }
    } catch {
      /* ignore — best effort */
    }
  };
  const scanAndHide = (root: ParentNode) => {
    const nodes = root.querySelectorAll?.(".selection-popup");
    if (!nodes) return;
    nodes.forEach((el: Element) => {
      hidePopup(el);
      guardLog("hid existing .selection-popup", {
        tag: (el as HTMLElement).tagName,
      });
    });
  };
  for (const targetDoc of docs) {
    try {
      scanAndHide(targetDoc);
      const view = targetDoc.defaultView as
        | (Window & {
            MutationObserver?: typeof MutationObserver;
          })
        | null;
      const Observer = view?.MutationObserver ?? MutationObserver;
      if (!targetDoc.body) continue;
      const observer = new Observer((mutations: MutationRecord[]) => {
        for (const m of mutations) {
          m.addedNodes.forEach((node: Node | null) => {
            if (!node || node.nodeType !== 1) return;
            const el = node as Element;
            if (el.matches?.(".selection-popup")) {
              hidePopup(el);
              guardLog("hid newly-inserted .selection-popup");
            }
            scanAndHide(el);
          });
        }
      });
      // Build options inside the target realm so Xray wrappers don't
      // strip the boolean properties (Firefox throws "must not be false"
      // when the wrapper drops the keys it can't see).
      const options = buildObserverOptions(view ?? targetDoc.defaultView);
      observer.observe(targetDoc.body, options);
      observers.push(observer);
      guardLog("MutationObserver attached", { url: safeDocUrl(targetDoc) });
    } catch (err) {
      guardLog("failed to attach observer", {
        url: safeDocUrl(targetDoc),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    destroy() {
      for (const targetDoc of docs) {
        targetDoc.documentElement?.classList.remove(
          SELECTION_POPUP_GUARD_CLASS,
        );
      }
      for (const observer of observers) observer.disconnect();
      guardLog("popup guard destroyed");
    },
  };
}

function buildObserverOptions(view: Window | null): MutationObserverInit {
  const fallback: MutationObserverInit = { childList: true, subtree: true };
  if (!view) return fallback;
  // Try Components.utils.cloneInto so the options object lives in the
  // target realm. Without this, Firefox's Xray wrapper can drop the boolean
  // keys, causing `MutationObserver.observe` to throw "must not be false".
  try {
    const Cu =
      (view as unknown as { Components?: { utils?: { cloneInto?: Function } } })
        .Components?.utils ??
      (
        globalThis as unknown as {
          Components?: { utils?: { cloneInto?: Function } };
        }
      ).Components?.utils;
    if (typeof Cu?.cloneInto === "function") {
      return Cu.cloneInto(fallback, view) as MutationObserverInit;
    }
  } catch {
    /* fall through */
  }
  // Fallback: construct via the target realm's Object so properties
  // are owned by that compartment.
  try {
    const ViewObject = (view as unknown as { Object?: ObjectConstructor })
      .Object;
    if (ViewObject) {
      const obj = new ViewObject() as MutationObserverInit &
        Record<string, unknown>;
      obj.childList = true;
      obj.subtree = true;
      return obj;
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

function safeDocUrl(doc: Document): string {
  try {
    return doc.location?.href ?? "(no url)";
  } catch (err) {
    return `(threw: ${err instanceof Error ? err.message : String(err)})`;
  }
}

function guardLog(message: string, extra?: Record<string, unknown>): void {
  logTranslateDebug("zai-translate-guard", message, extra);
}

function relatedDocuments(doc: Document): Document[] {
  const docs: Document[] = [];
  const add = (candidate: Document | null | undefined) => {
    try {
      if (candidate && !docs.includes(candidate)) docs.push(candidate);
    } catch {
      /* ignore */
    }
  };

  add(doc);
  let win: Window | null = null;
  try {
    win = doc.defaultView;
  } catch {
    return docs;
  }
  for (let i = 0; i < 4 && win; i++) {
    try {
      const parent: Window | null = win.parent;
      if (!parent || parent === win) break;
      let parentDoc: Document | null = null;
      try {
        parentDoc = parent.document;
      } catch {
        break; // cross-origin / chrome-privileged — stop walking
      }
      add(parentDoc);
      win = parent;
    } catch {
      break;
    }
  }
  return docs;
}

function ensureSelectionPopupGuardStyle(doc: Document): void {
  if (doc.getElementById(SELECTION_POPUP_GUARD_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = SELECTION_POPUP_GUARD_STYLE_ID;
  style.textContent = `
.${SELECTION_POPUP_GUARD_CLASS} .selection-popup {
  visibility: hidden !important;
  pointer-events: none !important;
}
`;
  (doc.head ?? doc.documentElement)?.append(style);
}

function makeBtn(
  doc: Document,
  label: string,
  title: string,
  handler?: () => void,
): HTMLButtonElement {
  const b = doc.createElement("button");
  b.type = "button";
  b.className = "zai-translate-overlay__btn";
  b.textContent = label;
  b.title = title;
  if (!handler) {
    b.disabled = true;
    return b;
  }
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    handler();
  });
  return b;
}

function mountHighlights(
  doc: Document,
  pageEl: HTMLElement,
  rects: PdfRect[],
  pageContent: PdfPageContent,
): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const rect of rects) {
    const highlight = doc.createElement("div");
    highlight.className = "zai-translate-highlight";
    positionPdfRect(highlight, pageEl, rect, pageContent);
    pageEl.appendChild(highlight);
    out.push(highlight);
  }
  return out;
}

function positionOverlay(
  overlay: HTMLElement,
  pageEl: HTMLElement,
  rects: PdfRect[],
  pageContent: PdfPageContent,
  position: TranslateOverlayPosition,
  size: TranslateOverlaySize,
  fontSize: number,
  analysisEnglishFontSize: number,
  analysisChineseFontSize: number,
): void {
  guardLog("positionOverlay", {
    rectCount: rects.length,
    pageRect: (() => {
      try {
        const r = pageEl.getBoundingClientRect();
        return { w: r.width, h: r.height, top: r.top, left: r.left };
      } catch {
        return null;
      }
    })(),
  });
  if (rects.length === 0) return;

  const xs = rects.map((r) => r[0]);
  const ys = rects.flatMap((r) => [r[1], r[3]]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);

  const pageRect = pageEl.getBoundingClientRect();
  const viewportRect = viewportRectForPdfRect(
    pageEl,
    [x0, y0, Math.max(...rects.map((r) => r[2])), y1],
    pageContent,
  );
  const cssLeft = viewportRect.left;
  const cssTopOfRect = viewportRect.top;
  const cssBottomOfRect = viewportRect.bottom;
  const win = overlay.ownerDocument?.defaultView ?? null;
  const viewportWidth = win?.innerWidth || pageRect.width || 1;
  const viewportHeight = win?.innerHeight || pageRect.height || 1;
  const margin = 8;
  const gap = 8;
  const bounds = visibleOverlayBounds(pageEl, {
    width: viewportWidth,
    height: viewportHeight,
    margin,
  });
  const boundsWidth = Math.max(1, bounds.right - bounds.left);
  const isAnalysis = overlay.classList.contains(
    "zai-translate-overlay--analysis",
  );
  const isExplain = overlay.classList.contains(
    "zai-translate-overlay--explain",
  );
  const targetWidth =
    size === "adaptive" ? 480 : isAnalysis ? 900 : isExplain ? 520 : 320;
  const minWidth = size === "adaptive" ? 280 : 220;
  const overlayWidth = Math.min(
    targetWidth,
    Math.max(minWidth, boundsWidth - margin * 2),
  );
  const anchorLeft = pageRect.left + cssLeft;
  const rectTop = pageRect.top + cssTopOfRect;
  const rectBottom = pageRect.top + cssBottomOfRect;
  const left = clamp(
    anchorLeft,
    bounds.left,
    Math.max(bounds.left, bounds.right - overlayWidth),
  );

  overlay.style.position = "fixed";
  overlay.style.left = `${left}px`;
  overlay.style.width = `${overlayWidth}px`;
  overlay.style.right = "";
  overlay.style.bottom = "";
  const visibleHeight = Math.max(84, bounds.bottom - bounds.top);
  overlay.style.maxHeight = `${visibleHeight}px`;
  overlay.style.setProperty(
    "--zai-overlay-body-max-height",
    size === "adaptive" ? `${Math.max(110, visibleHeight - 64)}px` : "110px",
  );

  const naturalHeight = measureOverlayHeight(overlay);
  const availableAbove = rectTop - gap - bounds.top;
  const availableBelow = bounds.bottom - rectBottom - gap;
  const minUsableHeight = 132;
  // --- Resolve position ---
  let actualPosition: TranslateOverlayPosition = position;
  const rectMidY = (rectTop + rectBottom) / 2;

  const spaceRight =
    bounds.right -
    (pageRect.left + cssLeft + (viewportRect.right - viewportRect.left));
  const spaceLeft = pageRect.left + cssLeft - bounds.left;
  const sideWidthLimit = isAnalysis ? 900 : isExplain ? 520 : 380;
  const sideW = Math.min(
    sideWidthLimit,
    Math.max(260, spaceRight - gap, spaceLeft - gap),
  );

  if (isAnalysis) {
    actualPosition = "below";
  } else if (position === "auto") {
    if (spaceRight >= 260) actualPosition = "right";
    else if (spaceLeft >= 260) actualPosition = "left";
    else actualPosition = "below";
  }

  if (actualPosition === "right" && spaceRight < 260)
    actualPosition = spaceLeft >= 260 ? "left" : "below";
  if (actualPosition === "left" && spaceLeft < 260)
    actualPosition = spaceRight >= 260 ? "right" : "below";

  if (
    actualPosition === "below" &&
    availableBelow < minUsableHeight &&
    availableAbove >= minUsableHeight
  )
    actualPosition = "above";
  else if (
    actualPosition === "above" &&
    availableAbove < minUsableHeight &&
    availableBelow >= minUsableHeight
  )
    actualPosition = "below";

  const isSide = actualPosition === "left" || actualPosition === "right";

  if (isSide) {
    overlay.style.width = `${sideW}px`;
    overlay.style.maxHeight = `${Math.max(100, visibleHeight)}px`;
    overlay.style.setProperty(
      "--zai-overlay-body-max-height",
      `${Math.max(80, visibleHeight - 60)}px`,
    );
    fitOverlayBody(overlay, Math.max(80, visibleHeight - 60));
    const h = Math.min(measureOverlayHeight(overlay), visibleHeight);
    overlay.style.maxHeight = `${h}px`;
    overlay.style.top = `${clamp(rectMidY - h / 2, bounds.top, Math.max(bounds.top, bounds.bottom - h))}px`;
    if (actualPosition === "right") {
      const rightEdge =
        pageRect.left + cssLeft + (viewportRect.right - viewportRect.left);
      overlay.style.left = `${clamp(rightEdge + gap, bounds.left, Math.max(bounds.left, bounds.right - sideW))}px`;
    } else {
      overlay.style.left = `${clamp(pageRect.left + cssLeft - gap - sideW, bounds.left, Math.max(bounds.left, bounds.right - sideW))}px`;
    }
    overlay.style.setProperty("--zai-overlay-arrow-left", "auto");
  } else {
    overlay.style.width = `${overlayWidth}px`;
    overlay.style.maxHeight = `${visibleHeight}px`;
    if (isExplain) {
      fitOverlayBody(overlay, visibleHeight);
    } else {
      // Keep the original auto-sizing behavior for translation and analysis.
      overlay.style.setProperty("--zai-overlay-body-max-height", "none");
    }
    const h = Math.min(measureOverlayHeight(overlay), visibleHeight);
    overlay.style.maxHeight = `${h}px`;
    overlay.style.top = `${clamp(
      actualPosition === "above" ? rectTop - h - gap : rectBottom + gap,
      bounds.top,
      Math.max(bounds.top, bounds.bottom - h),
    )}px`;
    overlay.style.setProperty(
      "--zai-overlay-arrow-left",
      `${clamp(anchorLeft - left + 8, 18, overlayWidth - 18)}px`,
    );
  }

  overlay.setAttribute("data-position", actualPosition);
  overlay.style.zIndex = "2147483647";
  overlay.style.setProperty("--zai-overlay-font-size", `${fontSize}px`);
  overlay.style.setProperty(
    "--zai-analysis-english-font-size",
    `${analysisEnglishFontSize}px`,
  );
  overlay.style.setProperty(
    "--zai-analysis-meaning-font-size",
    `${analysisChineseFontSize}px`,
  );
  overlay.style.visibility = "visible";
  guardLog("positionOverlay applied", {
    visibility: overlay.style.visibility,
    left: overlay.style.left,
    top: overlay.style.top,
    width: overlay.style.width,
    zIndex: overlay.style.zIndex,
    inDom: overlay.isConnected,
    parentTag: overlay.parentElement?.tagName,
    parentId: overlay.parentElement?.id,
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

interface OverlayViewport {
  width: number;
  height: number;
  margin: number;
}

interface OverlayBounds {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

function visibleOverlayBounds(
  pageEl: HTMLElement,
  viewport: OverlayViewport,
): OverlayBounds {
  let top = viewport.margin;
  let right = viewport.width - viewport.margin;
  let bottom = viewport.height - viewport.margin;
  let left = viewport.margin;

  // The overlay is mounted on the reader document body, so page wrappers do
  // not clip it. Constrain it only to the PDF reader's scrolling viewport.
  const readerBounds = nearestScrollBounds(pageEl);
  if (readerBounds) {
    top = Math.max(top, readerBounds.top + viewport.margin);
    right = Math.min(right, readerBounds.right - viewport.margin);
    bottom = Math.min(bottom, readerBounds.bottom - viewport.margin);
    left = Math.max(left, readerBounds.left + viewport.margin);
  }

  if (right <= left) {
    left = viewport.margin;
    right = viewport.width - viewport.margin;
  }
  if (bottom <= top) {
    top = viewport.margin;
    bottom = viewport.height - viewport.margin;
  }
  return { top, right, bottom, left };
}

function nearestScrollBounds(el: HTMLElement): OverlayBounds | null {
  const win = el.ownerDocument?.defaultView;
  if (!win) return null;
  for (let node = el.parentElement; node; node = node.parentElement) {
    const style = win.getComputedStyle(node);
    if (!style) continue;
    const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`;
    if (/(auto|scroll)/.test(overflow)) {
      const rect = node.getBoundingClientRect();
      return {
        top: rect.top,
        right: rect.left + (node.clientWidth || rect.width),
        bottom: rect.top + (node.clientHeight || rect.height),
        left: rect.left,
      };
    }
    if (node === el.ownerDocument.body) break;
  }
  return null;
}

function measureOverlayHeight(overlay: HTMLElement): number {
  const rectHeight = overlay.getBoundingClientRect().height;
  return Math.max(1, rectHeight || overlay.offsetHeight || 120);
}

function fitOverlayBody(overlay: HTMLElement, maxHeight: number): void {
  const body = overlay.querySelector<HTMLElement>(
    ".zai-translate-overlay__body",
  );
  const meta = overlay.querySelector<HTMLElement>(
    ".zai-translate-overlay__meta",
  );
  const actions = overlay.querySelector<HTMLElement>(
    ".zai-translate-overlay__actions",
  );
  const palette = overlay.querySelector<HTMLElement>(
    ".zai-translate-overlay__palette",
  );
  if (!body || !meta || !actions) return;
  const win = overlay.ownerDocument?.defaultView;
  const overlayStyle = win?.getComputedStyle(overlay);
  const bodyStyle = win?.getComputedStyle(body);
  const metaStyle = win?.getComputedStyle(meta);
  const actionsStyle = win?.getComputedStyle(actions);
  const paletteStyle = palette ? win?.getComputedStyle(palette) : undefined;
  const overlayInsets =
    px(overlayStyle?.paddingTop) +
    px(overlayStyle?.paddingBottom) +
    px(overlayStyle?.borderTopWidth) +
    px(overlayStyle?.borderBottomWidth);
  const bodyMargins = px(bodyStyle?.marginTop) + px(bodyStyle?.marginBottom);
  const metaHeight =
    measureOverlayHeight(meta) +
    px(metaStyle?.marginTop) +
    px(metaStyle?.marginBottom);
  const actionsHeight =
    measureOverlayHeight(actions) +
    px(actionsStyle?.marginTop) +
    px(actionsStyle?.marginBottom);
  const paletteHeight = palette
    ? measureOverlayHeight(palette) +
      px(paletteStyle?.marginTop) +
      px(paletteStyle?.marginBottom)
    : 0;
  const fixedHeight =
    metaHeight + actionsHeight + paletteHeight + overlayInsets;
  const bodyMax = Math.max(28, maxHeight - fixedHeight - bodyMargins - 4);
  overlay.style.setProperty(
    "--zai-overlay-body-max-height",
    `${Math.floor(bodyMax)}px`,
  );
}

function px(value: string | undefined): number {
  const n = value ? Number.parseFloat(value) : 0;
  return Number.isFinite(n) ? n : 0;
}

function positionPdfRect(
  el: HTMLElement,
  pageEl: HTMLElement,
  rect: PdfRect,
  pageContent: PdfPageContent,
): void {
  const pageRect = pageEl.getBoundingClientRect();
  const viewportRect = viewportRectForPdfRect(pageEl, rect, pageContent);
  el.style.position = "absolute";
  el.style.left = `${viewportRect.left}px`;
  el.style.top = `${viewportRect.top}px`;
  el.style.width = `${Math.max(1, viewportRect.right - viewportRect.left)}px`;
  el.style.height = `${Math.max(1, viewportRect.bottom - viewportRect.top)}px`;
}

interface ViewportRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function viewportRectForPdfRect(
  pageEl: HTMLElement,
  rect: PdfRect,
  pageContent: PdfPageContent,
): ViewportRect {
  const viewport = pageEl.ownerDocument
    ? pdfPageViewport(pageEl.ownerDocument, pageContent.pageIndex)
    : null;
  if (viewport) {
    const [x1, y2] = viewport.convertToViewportPoint(rect[0], rect[1]);
    const [x2, y1] = viewport.convertToViewportPoint(rect[2], rect[3]);
    return {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      right: Math.max(x1, x2),
      bottom: Math.max(y1, y2),
    };
  }

  return fallbackViewportRectForPdfRect(pageEl, rect, pageContent);
}

function fallbackViewportRectForPdfRect(
  pageEl: HTMLElement,
  rect: PdfRect,
  pageContent: PdfPageContent,
): ViewportRect {
  const pageRect = pageEl.getBoundingClientRect();
  const viewBox = pageContent.viewBox;
  const x0 = viewBox?.[0] ?? 0;
  const y0 = viewBox?.[1] ?? 0;
  const x1 = viewBox?.[2] ?? (pageRect.width || 1);
  const y1 = viewBox?.[3] ?? (pageRect.height || 1);
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);
  return {
    left: ((rect[0] - x0) / width) * pageRect.width,
    top: ((y1 - rect[3]) / height) * pageRect.height,
    right: ((rect[2] - x0) / width) * pageRect.width,
    bottom: ((y1 - rect[1]) / height) * pageRect.height,
  };
}

function pdfPageViewport(
  doc: Document,
  pageIndex: number,
): {
  convertToViewportPoint: (x: number, y: number) => [number, number];
} | null {
  const win = doc.defaultView as
    | (Window & {
        PDFViewerApplication?: unknown;
        wrappedJSObject?: { PDFViewerApplication?: unknown };
      })
    | null;
  const app =
    win?.PDFViewerApplication ?? win?.wrappedJSObject?.PDFViewerApplication;
  const page = (app as { pdfViewer?: { _pages?: unknown[] } } | null)?.pdfViewer
    ?._pages?.[pageIndex] as { viewport?: unknown } | undefined;
  const viewport = page?.viewport as
    | { convertToViewportPoint?: (x: number, y: number) => [number, number] }
    | undefined;
  return typeof viewport?.convertToViewportPoint === "function"
    ? (viewport as {
        convertToViewportPoint: (x: number, y: number) => [number, number];
      })
    : null;
}

const SELECTION_POPUP_GUARD_CLASS = "zai-translate-hide-selection-popup";
const SELECTION_POPUP_GUARD_STYLE_ID = "zai-translate-selection-popup-guard";
const STYLE_ID = "zai-translate-style";

function ensureStyle(doc: Document): void {
  let style = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement("style");
    style.id = STYLE_ID;
    (doc.head ?? doc.documentElement!).appendChild(style);
  }
  style.id = STYLE_ID;
  style.textContent = STYLE_TEXT;
}

const STYLE_TEXT = `
.zai-translate-highlight {
  background: rgba(255, 213, 79, 0.34);
  box-shadow: 0 0 0 1px rgba(255, 171, 0, 0.46) inset;
  border-radius: 2px;
  pointer-events: none;
  z-index: 19;
}
.zai-translate-overlay {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  background: #fff;
  border: 1px solid #d8d8da;
  border-radius: 8px;
  padding: 8px 10px 6px;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif;
  font-size: 12.5px;
  line-height: 1.5;
  color: #1d1d1f;
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.22), 0 0 0 1px rgba(255, 213, 79, 0.55);
  overflow: hidden;
  pointer-events: auto;
}
.zai-translate-overlay::before {
  content: "";
  position: absolute;
  left: var(--zai-overlay-arrow-left, 26px);
  width: 12px;
  height: 12px;
  background: #fff;
  transform: rotate(45deg);
}
.zai-translate-overlay[data-position="above"]::before {
  bottom: -7px;
  border-right: 1px solid #d8d8da;
  border-bottom: 1px solid #d8d8da;
}
.zai-translate-overlay[data-position="below"]::before {
  top: -7px;
  border-left: 1px solid #d8d8da;
  border-top: 1px solid #d8d8da;
}
.zai-translate-overlay[data-position="left"]::before {
  right: -7px;
  top: 50%;
  left: auto;
  margin-top: -6px;
  border-top: 1px solid #d8d8da;
  border-right: 1px solid #d8d8da;
}
.zai-translate-overlay[data-position="right"]::before {
  left: -7px;
  top: 50%;
  margin-top: -6px;
  border-left: 1px solid #d8d8da;
  border-bottom: 1px solid #d8d8da;
}
.zai-translate-overlay__meta {
  display: flex;
  flex: 0 0 auto;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  font-size: 10px;
  color: #888;
  margin-bottom: 4px;
}
.zai-translate-overlay__mode-bar {
  display: inline-flex;
  gap: 2px;
  background: #f1f3f6;
  border-radius: 7px;
  padding: 2px;
}
.zai-translate-overlay__mode-tab {
  border: none;
  background: transparent;
  padding: 3px 12px;
  border-radius: 5px;
  font-size: 11.5px;
  font-weight: 500;
  color: #666;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, box-shadow 0.15s;
  font-family: inherit;
}
.zai-translate-overlay__mode-tab--active {
  background: #fff;
  color: #1d1d1f;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.10);
}
.zai-translate-overlay__mode-tab:not(.zai-translate-overlay__mode-tab--active):hover {
  color: #333;
  background: rgba(0, 0, 0, 0.04);
}
.zai-translate-overlay__body {
  font-size: var(--zai-overlay-font-size, 14px);
  flex: 1 1 auto;
  min-height: 0;
  white-space: pre-wrap;
  color: #1d1d1f;
  line-height: 1.55;
  margin-bottom: 7px;
  max-height: var(--zai-overlay-body-max-height, 110px);
  overflow-y: auto;
}
.zai-translate-overlay__body--status { color: #666; font-style: italic; }
.zai-translate-overlay[data-position="above"] .zai-translate-overlay__body,
.zai-translate-overlay[data-position="below"] .zai-translate-overlay__body {
  overflow-y: visible;
  max-height: none;
}
.zai-translate-overlay--error .zai-translate-overlay__body { color: #b3261e; }
.zai-translate-overlay--error {
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(179, 38, 30, 0.42);
}
.zai-translate-overlay__actions {
  display: flex;
  flex: 0 0 auto;
  gap: 4px;
  align-items: center;
  min-width: 0;
}
.zai-translate-overlay__palette {
  display: flex;
  flex: 0 0 auto;
  gap: 4px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 5px;
  padding-top: 5px;
  border-top: 1px solid rgba(0, 0, 0, 0.08);
}
.zai-translate-overlay__swatch {
  width: 18px;
  height: 18px;
  border: 1px solid rgba(0, 0, 0, 0.24);
  border-radius: 4px;
  padding: 0;
  cursor: pointer;
  flex: 0 0 auto;
}
.zai-translate-overlay__swatch:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.22);
}
.zai-translate-overlay__swatch:disabled {
  opacity: 0.45;
  cursor: default;
}
.zai-translate-overlay__btn {
  background: #f5f5f7;
  border: 1px solid #e0e0e3;
  color: #333;
  border-radius: 5px;
  width: 26px;
  height: 24px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  cursor: pointer;
  font-size: 12px;
}
.zai-translate-overlay__btn:hover:not(:disabled) {
  background: #ebebef;
}
.zai-translate-overlay__btn--primary {
  background: #4a8cf7;
  border-color: #4a8cf7;
  color: #fff;
}
.zai-translate-overlay__btn:disabled { opacity: 0.4; cursor: default; }
.zai-translate-overlay__hint {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: #888;
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.zai-analysis-blocks {
  display: block;
  line-height: 1.6;
  padding: 4px 0 8px;
}
.zai-analyze-tok {
  display: inline-block;
  vertical-align: top;
  text-align: center;
  max-width: 100%;
}
.zai-analyze-tok__role {
  display: block;
  font-size: 10px;
  color: #888;
  line-height: 1.4;
}
.zai-analyze-tok__text {
  display: inline;
  font-size: var(--zai-overlay-font-size, 14px);
  color: #1d1d1f;
  font-weight: 500;
  line-height: 1.7;
  white-space: normal;
  overflow-wrap: break-word;
  border-radius: 2px;
  padding: 0 2px;
}
.zai-analyze-tok__meaning {
  display: block;
  font-size: 10px;
  color: #555;
  line-height: 1.3;
  white-space: normal;
  overflow-wrap: break-word;
  max-width: 100%;
}
.zai-analyze-clause {
  display: inline;
}
.zai-analyze-clause .zai-analyze-tok__text {
  text-decoration-line: underline;
  text-decoration-style: wavy;
  text-decoration-color: rgba(192, 57, 43, 0.85);
  text-decoration-thickness: 1px;
  text-underline-offset: 1px;
}
.zai-translate-overlay--analysis .zai-analyze-tok__text {
  font-size: var(--zai-analysis-english-font-size, 12px) !important;
}
.zai-translate-overlay--analysis .zai-analyze-tok__meaning {
  font-size: var(--zai-analysis-meaning-font-size, 11px) !important;
}
.zai-translate-overlay--analysis .zai-analyze-tok__role {
  font-size: 11px !important;
}
.zai-translate-overlay__body--analysis {
  max-height: var(--zai-overlay-body-max-height, 250px);
  overflow-y: auto;
}
.zai-analysis-translation-sep {
  border-top: 1px solid rgba(0, 0, 0, 0.10);
  margin: 8px 0 6px;
}
.zai-analysis-translation {
  font-size: var(--zai-overlay-font-size, 14px);
  color: #555;
  line-height: 1.5;
  white-space: pre-wrap;
}
.zai-translate-overlay__body--explain {
  box-sizing: border-box;
  max-height: var(--zai-overlay-body-max-height, 320px);

  overflow-y: auto;
  overscroll-behavior: contain;
}
.zai-translate-overlay[data-position="above"] .zai-translate-overlay__body--explain,
.zai-translate-overlay[data-position="below"] .zai-translate-overlay__body--explain {
  max-height: min(42vh, var(--zai-overlay-body-max-height, 360px));
  overflow-y: auto;
}
.zai-explanation-translation {
  position: sticky;
  top: 0;
  z-index: 2;
  margin: 0 0 8px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.12);
  background: #fff;
}
.zai-explanation-translation__summary {
  padding: 3px 2px 5px;
  color: #666;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
}
.zai-explanation-translation__text {
  max-height: min(22vh, 120px);
  padding: 0 2px 7px;
  overflow-y: auto;
  color: #444;
  font-size: var(--zai-overlay-font-size, 14px);
  line-height: 1.5;
  white-space: pre-wrap;
  overscroll-behavior: contain;
}
.zai-explanation-translation:not([open]) {
  border-bottom-color: rgba(0, 0, 0, 0.08);
}
.zai-explanation {
  color: #1d1d1f;
  line-height: 1.65;
  white-space: normal;
  overflow-wrap: anywhere;
}
.zai-explanation > :first-child { margin-top: 0; }
.zai-explanation > :last-child { margin-bottom: 0; }
.zai-explanation p { margin: 0 0 0.7em; }
.zai-explanation h1,
.zai-explanation h2,
.zai-explanation h3,
.zai-explanation h4 {
  margin: 0.85em 0 0.35em;
  line-height: 1.35;
  font-weight: 650;
}
.zai-explanation h1 { font-size: 1.22em; }
.zai-explanation h2 { font-size: 1.14em; }
.zai-explanation h3,
.zai-explanation h4 { font-size: 1.06em; }
.zai-explanation ul,
.zai-explanation ol {
  margin: 0.35em 0 0.75em;
  padding-left: 1.55em;
}
.zai-explanation li { margin: 0.2em 0; }
.zai-explanation blockquote {
  margin: 0.55em 0;
  padding: 0.15em 0 0.15em 0.75em;
  border-left: 3px solid #c7cbd1;
  color: #555;
}
.zai-explanation code {
  padding: 0.08em 0.28em;
  border-radius: 3px;
  background: #f1f3f5;
  font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
  font-size: 0.9em;
}
.zai-explanation pre {
  margin: 0.55em 0;
  padding: 7px 8px;
  border: 1px solid #e0e2e5;
  border-radius: 5px;
  background: #f6f7f8;
  overflow-x: auto;
  white-space: pre;
}
.zai-explanation pre code {
  padding: 0;
  background: transparent;
}
.zai-explanation table {
  width: 100%;
  margin: 0.55em 0;
  border-collapse: collapse;
  font-size: 0.94em;
}
.zai-explanation th,
.zai-explanation td {
  padding: 4px 6px;
  border: 1px solid #d8dadd;
  text-align: left;
  vertical-align: top;
}
.zai-explanation th { background: #f3f4f6; }
.zai-explanation a { color: #2868c7; }
.zai-explanation hr {
  border: 0;
  border-top: 1px solid #d8dadd;
  margin: 0.8em 0;
}
.zai-explanation__translation-label {
  color: #888;
  font-size: 10px;
  font-weight: 600;
  margin-bottom: 2px;
}
`;
