import {
  findNextMathRegion,
  renderMathInto,
  type MathRenderMode,
  type MathRegion,
} from "../ui/math";
import { parseMermaidMindmap, renderMindmapBlock } from "./mindmap-render";

interface ListState {
  tag: "ol" | "ul";
  element: HTMLElement;
  lastItem: HTMLLIElement | null;
}

interface MarkdownListItem {
  text: string;
  ordered: boolean;
  level: number;
}

// Hand-rolled Markdown block parser.
// =====================================================================
// WHY hand-rolled (not a library):
//   1. SECURITY — model output runs in the privileged Zotero XUL context.
//      Every text node is created via `createTextNode` / `textContent` so
//      a prompt-injected `<script>` or `<iframe>` cannot execute. A
//      general-purpose Markdown lib would need a sanitizer pass and we'd
//      still be one library upgrade away from a regression.
//   2. STREAMING — open delimiters (e.g. unclosed `**`) fall back to
//      literal text rather than corrupting subsequent chunks. The
//      renderer is called repeatedly during streaming with growing
//      content; partial syntax must never produce broken DOM.
//   3. BUNDLE SIZE — Zotero plugin loads in a XUL window; we want zero
//      external runtime cost for chat rendering.
//
// Supported subset (block):
//   #/##/###/#### headings, ordered+unordered lists (one nested level),
//   ```fence``` code blocks, > blockquote, paragraphs.
// NOT supported: tables, HR, image syntax, deep nested lists, setext headings.
// REF: Claudian's MessageRenderer (similar minimal subset for the same
//      streaming reasons); CommonMark spec we deliberately don't follow.
export function renderMarkdownInto(
  target: HTMLElement,
  markdown: string,
  mathMode: MathRenderMode = "html",
) {
  const doc = target.ownerDocument!;
  target.replaceChildren();
  const normalized = markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = normalized.split("\n");
  let paragraph: string[] = [];
  let listStack: ListState[] = [];
  let blockquote: HTMLElement | null = null;
  let codeLines: string[] | null = null;
  let codeLanguage = "";

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const p = doc.createElement("p");
    appendInlineMarkdown(p, paragraph.join(" "), mathMode);
    // Display math in source mode emits a block element. Nesting that inside
    // <p> is invalid HTML and note parsers may drop or duplicate it. Hoist
    // block children up to `target` and emit surrounding inline text as <p>'s.
    if (p.querySelector(":scope > pre, :scope > div.math-display")) {
      flushParagraphWithBlockHoist(target, p);
    } else {
      target.append(p);
    }
    paragraph = [];
  };

  const flushList = () => {
    listStack = [];
  };

  const flushBlockquote = () => {
    blockquote = null;
  };

  const appendListItem = (item: MarkdownListItem) => {
    flushParagraph();
    flushBlockquote();
    const tag = item.ordered ? "ol" : "ul";
    let level = Math.min(item.level, 1);
    if (level > 0 && !listStack[level - 1]?.lastItem) level = 0;

    if (level === 0) {
      if (!listStack[0] || listStack[0].tag !== tag) {
        const element = doc.createElement(tag);
        target.append(element);
        listStack = [{ tag, element, lastItem: null }];
      } else {
        listStack = [listStack[0]];
      }
    } else {
      const parent = listStack[level - 1].lastItem!;
      if (!listStack[level] || listStack[level].tag !== tag) {
        const element = doc.createElement(tag);
        parent.append(element);
        listStack[level] = { tag, element, lastItem: null };
      }
      listStack = listStack.slice(0, level + 1);
    }

    const list = listStack[level].element;
    const li = doc.createElement("li");
    appendInlineMarkdown(li, item.text, mathMode);
    list.append(li);
    listStack[level].lastItem = li;
  };

  const appendBlockquoteLine = (text: string) => {
    flushParagraph();
    flushList();
    if (!blockquote) {
      blockquote = doc.createElement("blockquote");
      target.append(blockquote);
    } else if (blockquote.childNodes.length) {
      blockquote.append(doc.createElement("br"));
    }
    appendInlineMarkdown(blockquote, text, mathMode);
  };

  // INVARIANT: code body uses `textContent`, NOT innerHTML — prompt
  // injection inside fenced code stays as displayed text. Class name uses
  // `language-${lang}` for any future syntax-highlighting CSS hook.
  // Special case: `mermaid` blocks with a `mindmap` diagram are rendered as
  // inline SVG using our dagre+SVG renderer (Mermaid library is CSP-blocked).
  const flushCode = () => {
    if (codeLines == null) return;
    const raw = codeLines.join("\n");
    if (codeLanguage === "mermaid") {
      const parsed = parseMermaidMindmap(raw);
      if (parsed) {
        parsed.source = raw;
        target.append(renderMindmapBlock(doc, parsed));
        codeLines = null;
        codeLanguage = "";
        return;
      }
    }
    const mathLatex = mathFenceToDisplayLatex(raw, codeLanguage);
    if (mathLatex) {
      renderMathInto(target, mathRegion(mathLatex), mathMode);
      codeLines = null;
      codeLanguage = "";
      return;
    }
    const pre = doc.createElement("pre");
    const code = doc.createElement("code");
    if (codeLanguage) code.className = `language-${codeLanguage}`;
    code.textContent = raw;
    pre.append(code);
    target.append(pre);
    codeLines = null;
    codeLanguage = "";
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (codeLines == null) {
        flushParagraph();
        flushList();
        flushBlockquote();
        codeLines = [];
        codeLanguage = line.slice(3).trim();
      } else {
        flushCode();
      }
      continue;
    }

    if (codeLines != null) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      flushBlockquote();
      continue;
    }

    const headingLevel = markdownHeadingLevel(line);
    if (headingLevel > 0) {
      flushParagraph();
      flushList();
      flushBlockquote();
      const heading = doc.createElement(`h${headingLevel}`);
      appendInlineMarkdown(
        heading,
        line.slice(headingLevel + 1).trim(),
        mathMode,
      );
      target.append(heading);
      continue;
    }

    const quote = blockquoteText(line);
    if (quote != null) {
      appendBlockquoteLine(quote);
      continue;
    }

    const listItem = markdownListItem(line);
    if (listItem) {
      appendListItem(listItem);
      continue;
    }

    flushBlockquote();
    paragraph.push(line.trim());
  }

  flushCode();
  flushParagraph();
}

function mathRegion(latex: string): MathRegion {
  return { start: 0, end: latex.length, latex, display: true };
}

function mathFenceToDisplayLatex(raw: string, language: string): string | null {
  if (!isMathLikeFenceLanguage(language)) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2000) return null;
  if (looksLikeLatexDocument(trimmed)) return null;

  const wrapped = findNextMathRegion(trimmed, 0);
  if (wrapped && wrapped.start === 0 && wrapped.end === trimmed.length) {
    return normalizeLatexLikeText(wrapped.latex);
  }

  if (!looksLikeFormulaBlock(trimmed)) return null;
  return alignMultilineFormula(
    trimmed
      .split("\n")
      .map((line) => normalizeLatexLikeText(line.trim()))
      .filter(Boolean),
  );
}

function isMathLikeFenceLanguage(language: string): boolean {
  const normalized = language.trim().toLowerCase();
  return ["", "text", "plain", "plaintext", "math", "latex", "tex"].includes(
    normalized,
  );
}

function looksLikeLatexDocument(text: string): boolean {
  return /\\(?:documentclass|usepackage|begin\{document\}|section\{)/.test(text);
}

function looksLikeFormulaBlock(text: string): boolean {
  const hasLatexCommand =
    /\\(?:hat|frac|sum|prod|int|mathbb|theta|alpha|beta|gamma|delta|lambda|mu|pi|tau|omega|begin|end|left|right|cdot|times|sim|approx|leq?|geq?)\b/.test(
      text,
    );
  const hasGreek = /[α-ωΑ-Ω]/.test(text);
  const hasSubscriptOrSuperscript = /[_^](?:\{[^}]+\}|[A-Za-z0-9])/.test(text);
  const hasRelation = /(^|\s)(?:=|≤|≥|≈|∼|~|\\leq?|\\geq?|\\approx|\\sim)(\s|$)/m.test(
    text,
  );
  const hasProbabilityShape = /\b(?:E|P|Pr)\s*(?:_|\[|\()/i.test(text);
  const score = [
    hasLatexCommand,
    hasGreek,
    hasSubscriptOrSuperscript,
    hasRelation,
    hasProbabilityShape,
  ].filter(Boolean).length;
  return score >= 2 && (hasLatexCommand || hasGreek || hasSubscriptOrSuperscript);
}

function normalizeLatexLikeText(text: string): string {
  return text
    .replace(/πθ/g, "\\pi_\\theta")
    .replace(/([A-Za-z])\u0302/g, "\\hat{$1}")
    .replace(/[αβγδθλμστωπ]/g, (ch) => greekLatex(ch))
    .replace(/[ΑΒΓΔΘΛΜΣΤΩΠ]/g, (ch) => greekLatex(ch));
}

function greekLatex(ch: string): string {
  const map: Record<string, string> = {
    α: "\\alpha",
    β: "\\beta",
    γ: "\\gamma",
    δ: "\\delta",
    θ: "\\theta",
    λ: "\\lambda",
    μ: "\\mu",
    σ: "\\sigma",
    τ: "\\tau",
    ω: "\\omega",
    π: "\\pi",
    Α: "A",
    Β: "B",
    Γ: "\\Gamma",
    Δ: "\\Delta",
    Θ: "\\Theta",
    Λ: "\\Lambda",
    Μ: "M",
    Σ: "\\Sigma",
    Τ: "T",
    Ω: "\\Omega",
    Π: "\\Pi",
  };
  return map[ch] ?? ch;
}

function alignMultilineFormula(lines: string[]): string | null {
  if (!lines.length) return null;
  if (lines.length === 1) return lines[0];
  return [
    "\\begin{aligned}",
    lines.map((line) => alignFormulaLine(line)).join(" \\\\\n"),
    "\\end{aligned}",
  ].join("\n");
}

function alignFormulaLine(line: string): string {
  if (/^(?:=|≤|≥|≈|∼|~|\\leq?|\\geq?|\\approx|\\sim)(?:\s|$)/.test(line)) {
    return `&${line}`;
  }
  const relation = line.match(/\s(?:=|≤|≥|≈|∼|~|\\leq?|\\geq?|\\approx|\\sim)\s/);
  if (relation?.index != null) {
    const index = relation.index + 1;
    return `${line.slice(0, index)}&${line.slice(index)}`;
  }
  return `&${line}`;
}

function blockquoteText(line: string): string | null {
  const trimmed = trimListIndent(line);
  if (!trimmed.startsWith(">")) return null;
  const body = trimmed.slice(1);
  return body.startsWith(" ") || body.startsWith("\t")
    ? body.trimStart()
    : body;
}

// Walks `<p>`'s children, splitting at direct child blocks so display
// math (or any other block emitted by inline rendering) sits at block
// level instead of nested inside <p>. We preserve a fresh <p> only for
// runs of inline content; empty runs are dropped.
function flushParagraphWithBlockHoist(
  target: HTMLElement,
  p: HTMLElement,
): void {
  const doc = target.ownerDocument!;
  let buffer: HTMLElement = doc.createElement("p");
  const flushBuffer = () => {
    if (buffer.childNodes.length > 0) target.append(buffer);
    buffer = doc.createElement("p");
  };
  let preceedingPreFlushed = false;
  for (const child of Array.from(p.childNodes) as Node[]) {
    if (isHoistableInlineRenderBlock(child)) {
      flushBuffer();
      target.append(child);
      preceedingPreFlushed = true;
    } else {
      // After hoisting a <pre>, the joined-paragraph mechanic leaves a
      // single leading space on the next text node (paragraph.join(" ")
      // glue). Trim it so the resulting <p> doesn't start with " ".
      if (
        preceedingPreFlushed &&
        buffer.childNodes.length === 0 &&
        child.nodeType === 3
      ) {
        const stripped = (child.textContent ?? "").replace(/^\s+/, "");
        if (stripped) buffer.append(doc.createTextNode(stripped));
        preceedingPreFlushed = false;
      } else {
        buffer.append(child);
        preceedingPreFlushed = false;
      }
    }
  }
  flushBuffer();
}

function isHoistableInlineRenderBlock(node: Node): boolean {
  if (node.nodeType !== 1) return false;
  const el = node as HTMLElement;
  return (
    el.tagName === "PRE" ||
    (el.tagName === "DIV" && el.classList.contains("math-display"))
  );
}

// Inline markdown: `code`, **bold**, [label](url).
// Streaming-safe pattern: at each step we look for the EARLIEST opening
// delimiter; if its closing partner is not yet in the buffer, we emit the
// rest as literal text and return. WHY: during streaming, the next chunk
// may bring the closing delimiter — but until then, NEVER half-render a
// `<strong>` or `<a>` (those would have to be unwound on the next call).
// INVARIANT: every emitted node is either createTextNode or createElement
// with textContent; no innerHTML on any path.
function appendInlineMarkdown(
  parent: HTMLElement,
  text: string,
  mathMode: MathRenderMode = "html",
) {
  const doc = parent.ownerDocument!;
  let cursor = 0;

  while (cursor < text.length) {
    // Math is checked first because its delimiters can legitimately contain
    // characters that would otherwise be parsed as bold/link/code (e.g.
    // `\[ a [b] \]`). Streaming-safe: findNextMathRegion returns null when
    // the closing delimiter has not arrived yet, so unclosed math falls
    // through to plain-text emission and is retried on the next chunk.
    //
    // All three modes (html / mathml / source) need detection so the
    // delimiters get consumed and the inner LaTeX is normalized. The
    // mode only affects the OUTPUT in renderMathInto: KaTeX HTML for
    // chat, KaTeX MathML for older note paths, or a plain
    // <span class="math">$..$</span> wrapper that Better Notes recognizes.
    const math = findNextMathRegion(text, cursor);
    const codeStart = text.indexOf("`", cursor);
    const boldStart = text.indexOf("**", cursor);
    const linkStart = text.indexOf("[", cursor);
    const starts = [
      math ? math.start : -1,
      codeStart,
      boldStart,
      linkStart,
    ].filter((index) => index >= 0);
    const next = starts.length ? Math.min(...starts) : -1;

    if (next < 0) {
      parent.append(doc.createTextNode(text.slice(cursor)));
      return;
    }
    if (next > cursor) {
      parent.append(doc.createTextNode(text.slice(cursor, next)));
    }

    if (math && next === math.start) {
      renderMathInto(parent, math, mathMode);
      cursor = math.end;
      continue;
    }

    if (next === codeStart) {
      const end = text.indexOf("`", next + 1);
      if (end < 0) {
        parent.append(doc.createTextNode(text.slice(next)));
        return;
      }
      const codeContent = text.slice(next + 1, end);
      // ESCAPE HATCH: models sometimes wrap a math formula in backticks
      // (`$$ x $$` or `$x$`), which would normally render as inline code
      // and leave the dollar delimiters visible. If the entire backticked
      // body — after trimming — is a single closed math region, treat
      // the author's intent as math and render accordingly. Genuine
      // "show LaTeX source" cases should use a fenced code block, which
      // is handled at the block level and never reaches here.
      const trimmed = codeContent.trim();
      const inner = findNextMathRegion(trimmed, 0);
      if (inner && inner.start === 0 && inner.end === trimmed.length) {
        renderMathInto(parent, inner, mathMode);
        cursor = end + 1;
        continue;
      }
      const code = doc.createElement("code");
      code.textContent = codeContent;
      parent.append(code);
      cursor = end + 1;
      continue;
    }

    if (next === boldStart) {
      const end = text.indexOf("**", next + 2);
      if (end < 0) {
        parent.append(doc.createTextNode(text.slice(next)));
        return;
      }
      const strong = doc.createElement("strong");
      appendInlineMarkdown(strong, text.slice(next + 2, end), mathMode);
      parent.append(strong);
      cursor = end + 2;
      continue;
    }

    const link = parseMarkdownLink(text, next);
    if (!link) {
      parent.append(doc.createTextNode(text[next]));
      cursor = next + 1;
      continue;
    }
    // GOTCHA: `target=_blank` + `rel=noreferrer` is required for any link
    // rendered from model output. Without rel=noreferrer, Firefox would
    // pass the Zotero XUL window's referrer to the opened page.
    const anchor = doc.createElement("a");
    anchor.href = link.href;
    anchor.target = "_blank";
    anchor.rel = "noreferrer";
    appendInlineMarkdown(anchor, link.label, mathMode);
    parent.append(anchor);
    cursor = link.end;
  }
}

function markdownHeadingLevel(line: string): number {
  let level = 0;
  while (level < line.length && line[level] === "#") level++;
  return level > 0 && level <= 4 && line[level] === " " ? level : 0;
}

function markdownListItem(line: string): MarkdownListItem | null {
  const indent = listIndentLevel(line);
  const trimmed = line.slice(countListIndentChars(line));
  if (trimmed.startsWith("- ") || trimmed.startsWith("* "))
    return { text: trimmed.slice(2).trim(), ordered: false, level: indent };
  let index = 0;
  while (index < trimmed.length && isDigit(trimmed[index])) index++;
  if (index === 0 || trimmed[index] !== "." || trimmed[index + 1] !== " ")
    return null;
  return { text: trimmed.slice(index + 2).trim(), ordered: true, level: indent };
}

function trimListIndent(line: string): string {
  return line.slice(countListIndentChars(line));
}

function countListIndentChars(line: string): number {
  let index = 0;
  while (line[index] === " " || line[index] === "\t") index++;
  return index;
}

function listIndentLevel(line: string): number {
  let width = 0;
  for (let index = 0; index < line.length; index++) {
    if (line[index] === " ") width += 1;
    else if (line[index] === "\t") width += 2;
    else break;
  }
  return width >= 2 ? 1 : 0;
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function parseMarkdownLink(
  text: string,
  start: number,
): { label: string; href: string; end: number } | null {
  const closeLabel = text.indexOf("]", start + 1);
  if (closeLabel < 0 || text[closeLabel + 1] !== "(") return null;
  const closeHref = text.indexOf(")", closeLabel + 2);
  if (closeHref < 0) return null;
  const href = text.slice(closeLabel + 2, closeHref).trim();
  if (!href) return null;
  return {
    label: text.slice(start + 1, closeLabel),
    href,
    end: closeHref + 1,
  };
}
