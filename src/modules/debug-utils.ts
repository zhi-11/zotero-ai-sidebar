export function rangeDebugInfo(selection: Selection): unknown[] {
  const ranges: unknown[] = [];
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    const startMath = closestLatexElement(range.startContainer);
    const endMath = closestLatexElement(range.endContainer);
    let clonedMathCount = 0;
    let clonedTags = "";
    try {
      const fragment = range.cloneContents();
      clonedMathCount = fragment.querySelectorAll?.("[data-latex]").length ?? 0;
      clonedTags = Array.from(fragment.childNodes)
        .slice(0, 8)
        .map((node) => node?.nodeName ?? "")
        .join(",");
    } catch {
      clonedTags = "<clone failed>";
    }
    ranges.push({
      index: i,
      collapsed: range.collapsed,
      startOffset: range.startOffset,
      endOffset: range.endOffset,
      start: nodeDebugInfo(range.startContainer),
      end: nodeDebugInfo(range.endContainer),
      startMath: mathDebugInfo(startMath),
      endMath: mathDebugInfo(endMath),
      clonedMathCount,
      clonedTags,
    });
  }
  return ranges;
}

function closestLatexElement(node: Node | null): HTMLElement | null {
  let cur: Node | null = node;
  while (cur) {
    if (cur.nodeType === 1) {
      const el = cur as HTMLElement;
      if (el.dataset?.latex !== undefined) return el;
    }
    cur = cur.parentNode;
  }
  return null;
}

function nodeDebugInfo(node: Node | null): unknown {
  if (!node) return null;
  const parent =
    node.nodeType === 1
      ? (node as Element)
      : node.parentElement ?? undefined;
  return {
    type: node.nodeType,
    name: node.nodeName,
    parent: parent
      ? `${parent.tagName.toLowerCase()}${parent.className ? `.${String(parent.className).split(/\s+/).filter(Boolean).slice(0, 3).join(".")}` : ""}`
      : "",
    text: node.nodeType === 3 ? previewText(node.textContent ?? "", 80) : "",
  };
}

function mathDebugInfo(el: HTMLElement | null): unknown {
  if (!el) return null;
  return {
    tag: el.tagName.toLowerCase(),
    className: el.className,
    display: el.dataset.display,
    latex: textDebugInfo(el.dataset.latex ?? "", 120),
  };
}

export function htmlDebugInfo(doc: Document, html: string): unknown {
  const tmp = doc.createElement("div");
  tmp.innerHTML = html;
  return {
    ...textDebugInfo(html),
    p: tmp.querySelectorAll("p").length,
    li: tmp.querySelectorAll("li").length,
    preMath: tmp.querySelectorAll("pre.math").length,
    spanMath: tmp.querySelectorAll("span.math").length,
    divMath: tmp.querySelectorAll("div.math").length,
    dataLatex: tmp.querySelectorAll("[data-latex]").length,
    topTags: Array.from(tmp.children)
      .slice(0, 10)
      .map((el) => el.tagName.toLowerCase())
      .join(","),
  };
}

export function htmlStringDebugInfo(html: string): Record<string, unknown> {
  return {
    ...textDebugInfo(html),
    p: countMatches(html, /<p[\s>]/g),
    li: countMatches(html, /<li[\s>]/g),
    preMath: countMatches(html, /<pre[^>]*class="[^"]*\bmath\b/g),
    spanMath: countMatches(html, /<span[^>]*class="[^"]*\bmath\b/g),
    divMath: countMatches(html, /<div[^>]*class="[^"]*\bmath\b/g),
    dataLatex: countMatches(html, /\sdata-latex=/g),
    displayDelimiters: countMatches(html, /\$\$[\s\S]*?\$\$/g),
  };
}

export function textDebugInfo(
  text: string,
  previewLimit = 240,
): Record<string, unknown> {
  return {
    length: text.length,
    lines: text ? text.split("\n").length : 0,
    head: previewText(text, previewLimit),
    tail: previewText(text.slice(-previewLimit), previewLimit),
  };
}

function previewText(text: string, limit = 240): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit
    ? `${normalized.slice(0, limit)}...`
    : normalized;
}

function countMatches(text: string, pattern: RegExp): number {
  return Array.from(text.matchAll(pattern)).length;
}

export function debugZai(label: string, detail?: unknown): void {
  try {
    const suffix =
      detail === undefined
        ? ""
        : ` ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
    Zotero.debug(`[zai-debug] ${label}${suffix}`);
  } catch {
    // Ignore logging failures; diagnostics must not break copy/import.
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

