// Parse a cleaned LaTeX paper source into a flat list of sections.
//
// WHY: when the user asks about a specific section of a long arXiv paper,
// the model should be able to fetch only that section via a tool, rather
// than re-sending the whole paper every turn. This is the parser that
// turns `main.tex` into addressable units.
//
// The parser is intentionally simple. It scans for `\section{...}`,
// `\subsection{...}`, `\subsubsection{...}`, and `\paragraph{...}`
// headers (with or without the `*` no-number variant), assigns an
// auto-numbered id ("3", "3.1", "3.1.2"), captures any `\label{...}` that
// follows the header in the same section body, and takes "body" as the
// text up to the next header at any level. It does not attempt full
// LaTeX parsing.

export interface TexSection {
  /** 1 = section, 2 = subsection, 3 = subsubsection, 4 = paragraph. */
  level: number;
  /** Dotted hierarchical id, e.g. "3" / "3.1" / "3.1.2". */
  number: string;
  /** Heading text (LaTeX still, with macros already expanded upstream). */
  title: string;
  /** Optional `\label{...}` that appears inside the section's body. */
  label?: string;
  /** Body text between this header and the next header (any level). */
  body: string;
  /** Character offset of the header itself in the source. */
  start: number;
  /** Character offset where the body ends (exclusive). */
  end: number;
}

const LEVELS: Record<string, number> = {
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
};

// `\section[short]{long}`/`\section*{}`/`\section{}`. The optional `[...]`
// short form is rare in papers but accepted. The braced argument captures
// one level of nested braces (so titles like `\section{The \emph{X} model}`
// survive).
const HEADER_RE =
  /\\(section|subsection|subsubsection|paragraph)\*?(?:\[[^\]]*\])?\{((?:[^{}]|\{[^{}]*\})*)\}/g;
const LABEL_RE = /\\label\{([^}]+)\}/;

export function parseSections(text: string): TexSection[] {
  const headers: {
    command: string;
    title: string;
    index: number;
    end: number;
  }[] = [];
  HEADER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEADER_RE.exec(text)) !== null) {
    headers.push({
      command: m[1],
      title: m[2],
      index: m.index,
      end: m.index + m[0].length,
    });
  }
  if (!headers.length) return [];

  const counters = [0, 0, 0, 0];
  const sections: TexSection[] = [];
  for (let i = 0; i < headers.length; i++) {
    const cur = headers[i];
    const level = LEVELS[cur.command];
    // Reset deeper counters when a higher level appears.
    for (let j = level; j < counters.length; j++) counters[j] = 0;
    counters[level - 1] += 1;
    const number = counters.slice(0, level).join(".");

    const nextIndex =
      i + 1 < headers.length ? headers[i + 1].index : text.length;
    const bodyText = text.slice(cur.end, nextIndex);
    // Capture a `\label{}` only if it appears reasonably close to the
    // header — papers conventionally put the label right after the title.
    const labelMatch = bodyText.slice(0, 400).match(LABEL_RE);

    sections.push({
      level,
      number,
      title: cur.title.trim(),
      ...(labelMatch ? { label: labelMatch[1] } : {}),
      body: bodyText.trim(),
      start: cur.index,
      end: nextIndex,
    });
  }
  return sections;
}

// Find a section by a flexible key: exact number ("3.1"), label
// ("sec:method"), or a case-insensitive substring of the title
// ("methodology"). Returns the first match.
export function findSection(
  sections: TexSection[],
  key: string,
): TexSection | null {
  const trimmed = key.trim();
  if (!trimmed) return null;
  const numberMatch = sections.find((s) => s.number === trimmed);
  if (numberMatch) return numberMatch;
  const labelMatch = sections.find((s) => s.label === trimmed);
  if (labelMatch) return labelMatch;
  const lower = trimmed.toLowerCase();
  const titleMatch = sections.find((s) =>
    s.title.toLowerCase().includes(lower),
  );
  return titleMatch ?? null;
}

// Compact table-of-contents view, suitable for placing in the system
// prompt so the model knows what sections it can request via a tool.
export interface TexTocEntry {
  number: string;
  level: number;
  title: string;
  label?: string;
  /** Character length of this section's body, for context budgeting. */
  bodyChars: number;
}

export const ARXIV_TOC_BLOCK_HEADER = "[arXiv paper — section index]";
export const ARXIV_EMPTY_TOC_BLOCK = "[arXiv paper — no detectable sections]";

export function isArxivTocBlock(text: string): boolean {
  return (
    text.startsWith(ARXIV_TOC_BLOCK_HEADER) ||
    text.startsWith(ARXIV_EMPTY_TOC_BLOCK)
  );
}

export function buildToc(sections: TexSection[]): TexTocEntry[] {
  return sections.map((s) => ({
    number: s.number,
    level: s.level,
    title: s.title,
    ...(s.label ? { label: s.label } : {}),
    bodyChars: s.body.length,
  }));
}

// Render the TOC as a compact text block suitable for pinning as the
// system / front context. Deterministic (same TOC → same string), so the
// prefix stays byte-stable across turns for prompt caching.
//
// Indented by section level so the model sees the structure at a glance.
// Section bodies are NOT included — the model fetches them via the
// `arxiv_get_section` tool on demand.
export function formatTocBlock(toc: TexTocEntry[]): string {
  if (!toc.length) return ARXIV_EMPTY_TOC_BLOCK;
  const lines = [
    ARXIV_TOC_BLOCK_HEADER,
    "The cleaned LaTeX source is cached locally; bodies are NOT inlined.",
    "Use these tools to read source parts on demand:",
    "  • arxiv_list_sections() — refresh this list as JSON",
    "  • arxiv_get_section(section) — fetch ONE section by number ('3.1'),",
    "    label ('sec:method'), or a substring of its title ('methodology')",
    "  • arxiv_get_equation(number) — fetch one numbered equation, e.g. 3",
    "  • arxiv_get_figure(number/name) — attach one figure image, e.g. Figure 3",
    "  • arxiv_get_table(number/name) — fetch one table source, e.g. Table 2",
    "  • arxiv_get_bibliography() — fetch .bbl/.bib references on demand",
    "  • zotero_get_full_pdf() — upgrade to the full LaTeX source if needed",
    "For whole-paper summaries/reviews, call zotero_get_full_pdf() before answering.",
    "Sections (number · title · body chars):",
  ];
  for (const entry of toc) {
    const indent = "  ".repeat(entry.level);
    const label = entry.label ? ` {${entry.label}}` : "";
    lines.push(
      `${indent}${entry.number}  ${entry.title}${label}  (${entry.bodyChars} chars)`,
    );
  }
  return lines.join("\n");
}
