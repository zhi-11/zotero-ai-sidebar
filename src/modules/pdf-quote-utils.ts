import { splitSentences } from "../translate/sentence-splitter";

const DEFAULT_PDF_QUOTE_MIN_CHARS = 32;
const PDF_QUOTE_LONG_CHARS = 80;

// Minimum fuzzy-match confidence before a "查看原文" click jumps the reader.
// A long passage can absorb noise — dropped inline citations like
// "(Author et al., 2024)", flattened math symbols — and still pinpoint the
// right place unambiguously, so its bar is lower. A short quote cannot: at
// 32 chars a 0.7 score is only ~22 matching characters, easily coincidental,
// so short quotes stay strict.
export function pdfQuoteConfidenceFloor(quoteLength: number): number {
  return quoteLength >= PDF_QUOTE_LONG_CHARS ? 0.7 : 0.85;
}

export function pdfQuoteLocateCandidates(
  rawText: string,
  minChars = DEFAULT_PDF_QUOTE_MIN_CHARS,
): string[] {
  const compactRaw = compactPdfQuoteText(rawText);
  const compact = stripOuterQuoteMarks(compactRaw);
  const quotedSpan = dominantQuotedSpan(compactRaw);
  const sentences = splitSentences(compact)
    .map((span) => stripOuterQuoteMarks(compactPdfQuoteText(span.text)))
    .filter((text) => text.length >= minChars);
  const candidates = [
    // A `标签："verbatim quote"` line can only locate by its quoted span —
    // the label (e.g. `原文论据：`) is not in the PDF. Prefer it when present.
    ...(quotedSpan ? [quotedSpan] : []),
    compact,
    compactRaw,
    ...sentences,
    ...ellipsisFragments(compact, minChars),
  ].filter((text) => text.length >= minChars);
  return [...new Set(candidates)];
}

// Models elide text mid-quote with "..." / "…". The elided gap defeats both
// exact and fuzzy matching against the PDF, but each non-elided fragment is
// usually still verbatim — so expose the substantial fragments (longest
// first, since a longer fragment locates less ambiguously) as extra
// candidates. Returns nothing when the quote has no ellipsis.
function ellipsisFragments(compact: string, minChars: number): string[] {
  if (!/\.{3,}|…/.test(compact)) return [];
  return compact
    .split(/\s*(?:\.{3,}|…)\s*/)
    .map((part) => stripOuterQuoteMarks(part.trim()))
    .filter((part) => part.length >= minChars)
    .sort((a, b) => b.length - a.length);
}

// Models often cite evidence as `标签："verbatim quote"` — a label, then the
// real PDF text inside quotation marks. Return the longest double-quoted span
// so the label is dropped and only the verbatim text is matched against the
// PDF. Returns null when the text contains no quoted span.
function dominantQuotedSpan(text: string): string | null {
  const re = /["“”]([^"“”]+)["“”]/g;
  let best = "";
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const inner = match[1]!.trim();
    if (inner.length > best.length) best = inner;
  }
  return best.length > 0 ? best : null;
}

export function firstPdfQuoteLocateCandidate(
  rawText: string,
  minChars = DEFAULT_PDF_QUOTE_MIN_CHARS,
): string {
  return pdfQuoteLocateCandidates(rawText, minChars)[0] ?? "";
}

export function pdfQuoteBlocks(
  root: HTMLElement,
  minChars = DEFAULT_PDF_QUOTE_MIN_CHARS,
): HTMLElement[] {
  return (
    Array.from(root.querySelectorAll("blockquote, li")) as HTMLElement[]
  ).filter((block) => {
    if (block.closest("a")) return false;
    // A list item only counts when it carries a verbatim quoted span: a leaf
    // <li> whose text contains `"…"`, possibly behind a label like
    // `原文论据：`. `- "passage"` and `- 原文论据："passage"` are common
    // alternatives to a `>` blockquote for citing PDF evidence. Prose bullets
    // and parent items that merely hold nested quotes are excluded.
    if (
      block.tagName.toLowerCase() === "li" &&
      !isQuotedLeafListItem(block, minChars)
    ) {
      return false;
    }
    const quote = firstPdfQuoteLocateCandidate(
      pdfQuoteBlockLocateText(block),
      minChars,
    );
    return !!quote && quote.length >= minChars;
  });
}

function isQuotedLeafListItem(item: HTMLElement, minChars: number): boolean {
  // Leaf only: a parent <li> holding nested quote items is not itself a
  // quote, and a <li> wrapping a <blockquote> is already covered by that
  // blockquote.
  if (item.querySelector("ul, ol, blockquote")) return false;
  // A quote item carries a verbatim quoted span `"…"` long enough to locate,
  // possibly behind a label like `原文论据：`. Plain prose bullets have none.
  const span = dominantQuotedSpan(item.textContent ?? "");
  return span != null && span.length >= minChars;
}

export function pdfQuoteBlockLocateText(block: HTMLElement): string {
  const lines: string[] = [];
  const buffer: string[] = [];
  const flush = () => {
    const text = buffer.join("").replace(/\s+/g, " ").trim();
    if (text) lines.push(text);
    buffer.length = 0;
  };
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      buffer.push(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (element.tagName.toLowerCase() === "br") {
      flush();
      return;
    }
    for (const child of Array.from(node.childNodes)) {
      if (child) walk(child);
    }
  };
  for (const child of Array.from(block.childNodes)) {
    if (child) walk(child);
  }
  flush();
  if (!lines.length) return (block.textContent ?? "").trim();
  const kept: string[] = [];
  for (const line of lines) {
    if (/^(译|翻译|译文|中文译文|译注|注释|说明|解读)\s*[:：]/i.test(line)) break;
    kept.push(line);
  }
  return kept.join("\n");
}

export function pdfQuoteLinkKey(quote: string): string {
  return quote.replace(/\s+/g, " ").trim().toLowerCase();
}

function compactPdfQuoteText(value: string): string {
  return value
    .replace(/^原文[:：]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripOuterQuoteMarks(value: string): string {
  let text = value.trim();
  const pairs: Array<[string, string]> = [
    ["“", "”"],
    ["‘", "’"],
    ['"', '"'],
    ["'", "'"],
  ];
  let changed = true;
  while (changed && text.length > 1) {
    changed = false;
    for (const [left, right] of pairs) {
      if (text.startsWith(left) && text.endsWith(right)) {
        text = text.slice(left.length, text.length - right.length).trim();
        changed = true;
      }
    }
  }
  return text;
}
