import { describe, expect, it } from "vitest";
import {
  parseSections,
  findSection,
  buildToc,
  formatTocBlock,
  isArxivTocBlock,
} from "../../src/context/tex-sections";

describe("parseSections", () => {
  it("returns [] when there are no section headers", () => {
    expect(parseSections("just prose, no headers")).toEqual([]);
  });

  it("captures a single section's title and body", () => {
    const text = "preamble\n\\section{Introduction}\nbody text here\nmore";
    const out = parseSections(text);
    expect(out).toHaveLength(1);
    expect(out[0].level).toBe(1);
    expect(out[0].number).toBe("1");
    expect(out[0].title).toBe("Introduction");
    expect(out[0].body).toBe("body text here\nmore");
    expect(out[0].label).toBeUndefined();
  });

  it("numbers sections and subsections hierarchically", () => {
    const text = [
      "\\section{One}",
      "a",
      "\\section{Two}",
      "b",
      "\\subsection{Two-A}",
      "c",
      "\\subsection{Two-B}",
      "d",
      "\\subsubsection{Two-B-1}",
      "e",
      "\\section{Three}",
      "f",
    ].join("\n");
    const out = parseSections(text);
    expect(out.map((s) => `${s.number} ${s.title}`)).toEqual([
      "1 One",
      "2 Two",
      "2.1 Two-A",
      "2.2 Two-B",
      "2.2.1 Two-B-1",
      "3 Three",
    ]);
  });

  it("captures \\label that follows the header inside the body", () => {
    const text =
      "\\section{Method}\n\\label{sec:method}\nbody\n\\section{Next}\nz";
    const [first] = parseSections(text);
    expect(first.label).toBe("sec:method");
  });

  it("accepts the starred (no-number) form", () => {
    const text = "\\section*{Acknowledgements}\nthanks";
    const out = parseSections(text);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("Acknowledgements");
  });

  it("preserves a section title containing inner braces", () => {
    const text = "\\section{The \\emph{X} model}\nbody";
    const out = parseSections(text);
    expect(out[0].title).toBe("The \\emph{X} model");
  });
});

describe("findSection", () => {
  const text = [
    "\\section{Introduction}",
    "\\label{sec:intro}",
    "i",
    "\\section{Methodology}",
    "\\label{sec:method}",
    "m",
    "\\subsection{Loss function}",
    "l",
  ].join("\n");
  const sections = parseSections(text);

  it("finds by exact dotted number", () => {
    expect(findSection(sections, "2.1")?.title).toBe("Loss function");
  });
  it("finds by label", () => {
    expect(findSection(sections, "sec:method")?.title).toBe("Methodology");
  });
  it("finds by case-insensitive title substring", () => {
    expect(findSection(sections, "intro")?.number).toBe("1");
  });
  it("returns null when nothing matches", () => {
    expect(findSection(sections, "nope")).toBeNull();
  });
});

describe("buildToc", () => {
  it("emits a compact TOC with body char counts", () => {
    const sections = parseSections(
      "\\section{One}\nabc\n\\subsection{Sub}\n\\label{l}\ndefghij",
    );
    const toc = buildToc(sections);
    expect(toc).toEqual([
      {
        number: "1",
        level: 1,
        title: "One",
        bodyChars: sections[0].body.length,
      },
      {
        number: "1.1",
        level: 2,
        title: "Sub",
        label: "l",
        bodyChars: sections[1].body.length,
      },
    ]);
  });
});

describe("formatTocBlock", () => {
  it("renders an empty TOC as a placeholder line", () => {
    expect(formatTocBlock([])).toBe("[arXiv paper — no detectable sections]");
    expect(isArxivTocBlock(formatTocBlock([]))).toBe(true);
  });

  it("includes a usage header and indents by section level", () => {
    const toc = buildToc(
      parseSections(
        "\\section{Introduction}\nabc\n\\subsection{Setup}\n\\label{l}\nxyz",
      ),
    );
    const out = formatTocBlock(toc);
    expect(out).toContain("[arXiv paper — section index]");
    expect(out).toContain("arxiv_get_section(section)");
    expect(out).toContain("arxiv_get_equation(number)");
    expect(out).toContain("arxiv_get_figure(number/name)");
    expect(out).toContain("arxiv_get_table(number/name)");
    expect(out).toContain("arxiv_get_bibliography()");
    expect(out).toContain("zotero_get_full_pdf()");
    expect(out).toContain("For whole-paper summaries/reviews");
    expect(isArxivTocBlock(out)).toBe(true);
    // Top-level "1 Introduction"; child "1.1 Setup {l}" indented deeper.
    const idxParent = out.indexOf("1  Introduction");
    const idxChild = out.indexOf("1.1  Setup {l}");
    expect(idxParent).toBeGreaterThan(0);
    expect(idxChild).toBeGreaterThan(idxParent);
    // Child indented more than parent.
    expect(out.slice(out.lastIndexOf("\n", idxChild) + 1, idxChild)).toMatch(
      /^ {4}/,
    );
    expect(out.slice(out.lastIndexOf("\n", idxParent) + 1, idxParent)).toMatch(
      /^ {2}/,
    );
  });

  it("is deterministic — same TOC produces byte-identical output", () => {
    const toc = buildToc(parseSections("\\section{A}\na\n\\section{B}\nb"));
    expect(formatTocBlock(toc)).toBe(formatTocBlock(toc));
  });
});
