import { splitSentences } from "../translate/sentence-splitter";

const DEFAULT_PDF_QUOTE_MIN_CHARS = 32;

export function pdfQuoteLocateCandidates(
  rawText: string,
  minChars = DEFAULT_PDF_QUOTE_MIN_CHARS,
): string[] {
  const compact = stripOuterQuoteMarks(compactPdfQuoteText(rawText));
  const sentences = splitSentences(compact)
    .map((span) => stripOuterQuoteMarks(compactPdfQuoteText(span.text)))
    .filter((text) => text.length >= minChars);
  const candidates = [
    compact,
    compactPdfQuoteText(rawText),
    ...sentences,
  ].filter((text) => text.length >= minChars);
  return [...new Set(candidates)];
}

export function firstPdfQuoteLocateCandidate(
  rawText: string,
  minChars = DEFAULT_PDF_QUOTE_MIN_CHARS,
): string {
  return pdfQuoteLocateCandidates(rawText, minChars)[0] ?? "";
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
