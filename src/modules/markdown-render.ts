import {
  findNextMathRegion,
  renderMathInto,
  type MathRenderMode,
} from "../ui/math";

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
//   #/##/###/#### headings, ordered+unordered lists (no nesting),
//   ```fence``` code blocks, > blockquote, paragraphs.
// NOT supported: tables, HR, image syntax, nested lists, setext headings.
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
  let list: HTMLElement | null = null;
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
    list = null;
  };

  const flushBlockquote = () => {
    blockquote = null;
  };

  const appendListItem = (text: string, ordered: boolean) => {
    flushParagraph();
    flushBlockquote();
    const tag = ordered ? "ol" : "ul";
    if (!list || list.tagName.toLowerCase() !== tag) {
      list = doc.createElement(tag);
      target.append(list);
    }
    const li = doc.createElement("li");
    appendInlineMarkdown(li, text, mathMode);
    list.append(li);
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
  const flushCode = () => {
    if (codeLines == null) return;
    const pre = doc.createElement("pre");
    const code = doc.createElement("code");
    if (codeLanguage) code.className = `language-${codeLanguage}`;
    code.textContent = codeLines.join("\n");
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

    const unordered = unorderedListText(line);
    if (unordered != null) {
      appendListItem(unordered, false);
      continue;
    }

    const ordered = orderedListText(line);
    if (ordered != null) {
      appendListItem(ordered, true);
      continue;
    }

    flushBlockquote();
    paragraph.push(line.trim());
  }

  flushCode();
  flushParagraph();
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

function unorderedListText(line: string): string | null {
  const trimmed = trimListIndent(line);
  if (trimmed.startsWith("- ") || trimmed.startsWith("* "))
    return trimmed.slice(2).trim();
  return null;
}

function orderedListText(line: string): string | null {
  const trimmed = trimListIndent(line);
  let index = 0;
  while (index < trimmed.length && isDigit(trimmed[index])) index++;
  if (index === 0 || trimmed[index] !== "." || trimmed[index + 1] !== " ")
    return null;
  return trimmed.slice(index + 2).trim();
}

function trimListIndent(line: string): string {
  let index = 0;
  while (line[index] === " " || line[index] === "\t") index++;
  return line.slice(index);
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
