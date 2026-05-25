import { describe, expect, it } from "vitest";
import { renderMarkdownInto } from "../../src/modules/markdown-render";

function render(markdown: string): HTMLElement {
  const root = document.createElement("div");
  renderMarkdownInto(root, markdown);
  return root;
}

describe("renderMarkdownInto", () => {
  it("renders GFM pipe tables as scrollable tables", () => {
    const root = render(
      [
        "主要数值如下：",
        "",
        "| Method | PQ | mIoU |",
        "| :--- | ---: | ---: |",
        "| **RangeFormer** | 73.3 | 66.6 |",
        "| P-RangeFormer | 64.2 | 59.5 |",
      ].join("\n"),
    );

    const wrap = root.querySelector(".markdown-table-wrap");
    const table = root.querySelector("table.markdown-table");
    expect(wrap).not.toBeNull();
    expect(table).not.toBeNull();
    expect(root.querySelectorAll("th")).toHaveLength(3);
    expect(root.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(root.querySelector("tbody strong")?.textContent).toBe("RangeFormer");
    expect(
      (root.querySelectorAll("th")[1] as HTMLElement).style.textAlign,
    ).toBe("right");
  });

  it("keeps malformed pipe text as a paragraph instead of a table", () => {
    const root = render("Method | PQ | mIoU\nRangeFormer | 73.3 | 66.6");

    expect(root.querySelector("table")).toBeNull();
    expect(root.textContent).toContain("Method | PQ | mIoU");
  });

  it("keeps indented list items nested under their parent item", () => {
    const root = render(
      [
        "- Category: system paper",
        "- Context: related to VLAs; references:",
        "  - Black 2024 — pi0 flow VLA",
        "  - Pertsch 2025 — FAST tokenization",
        "- Correctness: check ablations",
      ].join("\n"),
    );

    const top = root.querySelector(":scope > ul")!;
    expect(top).not.toBeNull();
    expect(top.children).toHaveLength(3);
    expect(top.children[1].childNodes[0]?.textContent).toBe(
      "Context: related to VLAs; references:",
    );

    const nested = top.children[1].querySelector(":scope > ul")!;
    expect(nested).not.toBeNull();
    expect(Array.from(nested.children).map((li) => li.textContent)).toEqual([
      "Black 2024 — pi0 flow VLA",
      "Pertsch 2025 — FAST tokenization",
    ]);
    expect(top.children[2].textContent).toBe("Correctness: check ablations");
  });

  it("renders math-like fenced text blocks as display math", () => {
    const root = render(
      [
        "```text",
        "πθ(a_{t:t+H}, \\hat l | o_t, l)",
        "= πθ(a_{t:t+H} | o_t, \\hat l) πθ(\\hat l | o_t, l)",
        "```",
      ].join("\n"),
    );

    const math = root.querySelector(".math-display") as HTMLElement | null;
    expect(math).not.toBeNull();
    expect(math?.dataset.latex).toContain("\\pi_\\theta");
    expect(root.querySelector("pre code")).toBeNull();
  });

  it("keeps ordinary fenced text blocks as code", () => {
    const root = render(
      ["```text", "Run this command exactly:", "npm test", "```"].join("\n"),
    );

    expect(root.querySelector(".math-display")).toBeNull();
    expect(root.querySelector("pre code")?.textContent).toContain("npm test");
  });

  it("renders a LaTeX equation environment inside a blockquote", () => {
    const root = render(
      [
        "> We decompose the distribution as",
        "> \\begin{equation*}",
        "> \\pi_\\theta(a \\vert o) = \\pi_\\theta(a \\vert \\hat{\\ell})\\pi_\\theta(\\hat{\\ell} \\vert o)",
        "> \\end{equation*}",
        "> where the action distribution depends on the subtask.",
      ].join("\n"),
    );

    const quote = root.querySelector("blockquote") as HTMLElement | null;
    const math = quote?.querySelector(".math-display") as HTMLElement | null;
    expect(quote).not.toBeNull();
    expect(math).not.toBeNull();
    expect(math?.dataset.latex).toContain("\\pi_\\theta(a \\vert o)");
    expect(quote?.textContent).not.toContain("\\begin{equation");
    expect(root.querySelector(".katex-error")).toBeNull();
  });

  it("does not render source-only equation labels inside blockquotes", () => {
    const root = render(
      [
        "> Our model is optimized to minimize the combined loss",
        "> \\begin{align}",
        "> x &= y \\notag \\\\",
        "> z &= w, \\label{eq:cotrain}",
        "> \\end{align}",
      ].join("\n"),
    );

    const math = root.querySelector(".math-display") as HTMLElement | null;
    expect(math).not.toBeNull();
    expect(math?.dataset.latex).not.toContain("\\label");
    expect(math?.dataset.latex).not.toContain("\\notag");
    expect(root.textContent).not.toContain("eq:cotrain");
    expect(root.querySelector(".katex-error")).toBeNull();
  });

  it("renders residual LaTeX citation commands as neutral citation markers", () => {
    const root = render(
      "Finally we include CapsFusion \\cite{yu2024capsfusion}, COCO \\citep[see]{chen2015microsoft}.",
    );

    expect(root.textContent).toContain(
      "Finally we include CapsFusion [citation], COCO [citation].",
    );
    expect(root.textContent).not.toContain("\\cite");
    expect(root.textContent).not.toContain("yu2024capsfusion");
  });

  it("renders residual LaTeX references as neutral reference markers", () => {
    const root = render("Figure~\\ref{fig:home} and Eq.~\\eqref{eq:loss}");

    expect(root.textContent).toBe("Figure~[ref] and Eq.~[ref]");
    expect(root.textContent).not.toContain("\\ref");
    expect(root.textContent).not.toContain("eq:loss");
  });

  it("renders residual LaTeX enumerate environments without source commands", () => {
    const root = render(
      [
        "> Our experiments focus on the following questions:",
        "> \\begin{enumerate}",
        "> \\item Can $\\pi_{0.5}$ generalize?",
        "> \\item How does it scale?",
        "> \\end{enumerate}",
      ].join("\n"),
    );

    expect(root.textContent).toContain("1. Can");
    expect(root.textContent).toContain("2. How");
    expect(root.textContent).not.toContain("\\begin{enumerate}");
    expect(root.textContent).not.toContain("\\item");
    expect(root.textContent).not.toContain("\\end{enumerate}");
  });

  it("renders residual LaTeX text wrappers without exposing source commands", () => {
    const root = render(
      "an action \\emph{chunk}, \\textbf{important}, and \\texttt{FAST}",
    );

    expect(root.textContent).toBe("an action chunk, important, and FAST");
    expect(root.querySelector("em")?.textContent).toBe("chunk");
    expect(root.querySelector("strong")?.textContent).toBe("important");
    expect(root.querySelector("code")?.textContent).toBe("FAST");
    expect(root.textContent).not.toContain("\\emph");
  });

  it("renders Markdown emphasis emitted by the source cleaner", () => {
    const root = render("an action *chunk*");

    expect(root.textContent).toBe("an action chunk");
    expect(root.querySelector("em")?.textContent).toBe("chunk");
  });

  // A model often writes one formula across several source lines for
  // readability. Each line is NOT its own display row: forcing them into
  // separate \begin{aligned} rows splits `\left[` from `\right]`, which is
  // invalid LaTeX. KaTeX then rejects the block and emits red `.katex-error`
  // spans — the exact symptom the user reported.
  it("renders a formula split across source lines as one valid expression", () => {
    const root = render(
      [
        "```math",
        "\\mathbb{E}_{D,\\tau,\\omega}",
        "\\left[",
        "H(x_{1:M}, f^l_\\theta(o_t,l))",
        "+",
        "\\alpha",
        "\\left\\|",
        "\\omega - a_{t:t+H}",
        "-",
        "f^a_\\theta(a^{\\tau,\\omega}_{t:t+H}, o_t, l)",
        "\\right\\|^2",
        "\\right]",
        "```",
      ].join("\n"),
    );

    const math = root.querySelector(".math-display") as HTMLElement | null;
    expect(math).not.toBeNull();
    // KaTeX renders unparseable LaTeX as red `.katex-error` spans.
    expect(root.querySelector(".katex-error")).toBeNull();
    // The whole block is one expression — no aligned rows splitting the
    // \left/\right pairs apart.
    expect(math?.dataset.latex).not.toContain("\\begin{aligned}");
    expect(math?.dataset.latex).toContain("\\left[");
    expect(math?.dataset.latex).toContain("\\right]");
  });

  // The flip side: a genuine multi-step derivation, aligned at relations,
  // must still stack into separate \begin{aligned} rows.
  it("keeps a multi-step derivation as separate aligned rows", () => {
    const root = render(
      [
        "```math",
        "\\hat{y}_t = \\alpha x_t + \\beta",
        "= \\gamma z_t",
        "```",
      ].join("\n"),
    );

    const math = root.querySelector(".math-display") as HTMLElement | null;
    expect(math).not.toBeNull();
    expect(root.querySelector(".katex-error")).toBeNull();
    expect(math?.dataset.latex).toContain("\\begin{aligned}");
    expect(math?.dataset.latex).toContain("\\\\");
  });

  // A relation-led line that lands INSIDE an open `\left[ ... \right]`
  // group is still a continuation, not a new row — breaking here would
  // re-tear the \left/\right pair apart.
  it("never breaks an aligned row inside an open delimiter group", () => {
    const root = render(
      [
        "```math",
        "\\left[",
        "\\sum_i x_i",
        "= S_{\\text{total}}",
        "\\right]",
        "```",
      ].join("\n"),
    );

    const math = root.querySelector(".math-display") as HTMLElement | null;
    expect(math).not.toBeNull();
    expect(root.querySelector(".katex-error")).toBeNull();
    expect(math?.dataset.latex).not.toContain("\\begin{aligned}");
  });

  // A model often writes a formula as flat pseudo-text with Unicode Greek
  // glyphs and no braces: `fθl`, `ωt`. normalizeLatexLikeText turns each
  // glyph into a multi-letter command (`θ` → `\theta`). Without a
  // terminator, a following ASCII letter glues onto the command name:
  // `fθl` → `f\thetal`. KaTeX prints an unsupported command as its literal
  // source, so a raw `\thetal` shows up in the formula — the user-reported
  // π0.5 symptom.
  it("does not glue a Greek command onto a following letter", () => {
    const root = render(
      [
        "```text",
        "E[",
        "  H(x1:M, fθl(ot, l))",
        "  + α ||ω - at:t+H - fθa(aτ,ωt:t+H, ot, l)||²",
        "]",
        "```",
      ].join("\n"),
    );

    const math = root.querySelector(".math-display") as HTMLElement | null;
    expect(math).not.toBeNull();
    // θ/ω were substituted into commands, never fused with the next letter.
    expect(math?.dataset.latex).toContain("\\theta");
    expect(math?.dataset.latex).toContain("\\omega");
    expect(math?.dataset.latex).not.toMatch(/\\theta[A-Za-z]/);
    expect(math?.dataset.latex).not.toMatch(/\\omega[A-Za-z]/);
    // Nothing surfaces as a raw `\command`: KaTeX prints unknown commands
    // verbatim, so a backslash in the rendered text means a glued command.
    expect(math?.textContent ?? "").not.toContain("\\");
  });
});
