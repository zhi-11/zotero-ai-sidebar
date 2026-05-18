import { describe, expect, it } from "vitest";
import {
  pdfQuoteBlockLocateText,
  pdfQuoteBlocks,
  pdfQuoteConfidenceFloor,
  pdfQuoteLinkKey,
  pdfQuoteLocateCandidates,
} from "../../src/modules/pdf-quote-utils";

describe("pdf quote DOM helpers", () => {
  it("uses only original quote lines before translations", () => {
    const block = document.createElement("blockquote");
    block.innerHTML =
      "Original claim line one.<br>Original claim line two.<br>译：中文翻译。";

    expect(pdfQuoteBlockLocateText(block)).toBe(
      "Original claim line one.\nOriginal claim line two.",
    );
  });

  it("finds quote block candidates and skips links", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <blockquote>This quote is long enough to become a PDF quote target.</blockquote>
      <a><blockquote>This linked quote should be ignored completely.</blockquote></a>
    `;

    expect(pdfQuoteBlocks(root, 32)).toHaveLength(1);
  });

  it("normalizes quote keys for prelocated links", () => {
    expect(pdfQuoteLinkKey("  A\n  Quote   Here ")).toBe("a quote here");
  });

  it("treats a list item wrapped entirely in quote marks as a quote block", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <ul>
        <li>原文论据：
          <ul>
            <li>"we propose EfficientTAMs, lightweight track anything models with low latency."</li>
            <li>this bullet is plain commentary, not a verbatim quote at all</li>
          </ul>
        </li>
      </ul>`;

    const blocks = pdfQuoteBlocks(root, 32);

    // Only the fully quote-wrapped leaf <li> becomes a target — not the plain
    // commentary bullet, not the parent item that just holds nested quotes.
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.textContent).toContain("we propose EfficientTAMs");
  });

  it("recognizes a list item that puts a label before the quote", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <ul>
        <li>核心论点：总体主张
          <ul>
            <li>原文论据："we propose EfficientTAMs, lightweight track anything models with low latency."</li>
            <li>这是一句没有引文的普通点评，不应被识别为引用</li>
          </ul>
        </li>
      </ul>`;

    const blocks = pdfQuoteBlocks(root, 32);

    // The quoted span sits behind a `原文论据：` label — it must still count.
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.textContent).toContain("we propose EfficientTAMs");
  });
});

describe("pdf quote locate candidates", () => {
  it("offers each side of an elided '...' quote as a verbatim candidate", () => {
    const candidates = pdfQuoteLocateCandidates(
      "Additionally, that the memory tokens ... are long and hurt the overall efficiency.",
      32,
    );
    // The elided gap defeats matching; each clean side must be its own
    // candidate so the verbatim half can still locate.
    expect(candidates).toContain("Additionally, that the memory tokens");
    expect(candidates).toContain("are long and hurt the overall efficiency.");
  });

  it("splits a '...' with no surrounding spaces", () => {
    const candidates = pdfQuoteLocateCandidates(
      "these coarse spatial memory tokens...are concatenated with object pointer tokens",
      32,
    );
    expect(candidates).toContain("these coarse spatial memory tokens");
    expect(candidates).toContain("are concatenated with object pointer tokens");
  });

  it("leaves a quote with no ellipsis unchanged", () => {
    const text = "Key components of SAM 2 drive its segmentation performance.";
    expect(pdfQuoteLocateCandidates(text, 32)).toContain(text);
  });

  it("pulls the quoted span out from behind a Chinese label", () => {
    const candidates = pdfQuoteLocateCandidates(
      '原文论据："we propose EfficientTAMs, lightweight track anything models with low latency."',
      32,
    );
    // The label must be dropped — only the verbatim span can match the PDF,
    // and it must be the first (preferred) candidate.
    expect(candidates[0]).toBe(
      "we propose EfficientTAMs, lightweight track anything models with low latency.",
    );
  });
});

describe("pdf quote confidence floor", () => {
  it("relaxes the bar for long passages and stays strict for short ones", () => {
    // A long quote can absorb dropped-citation / math noise unambiguously.
    expect(pdfQuoteConfidenceFloor(200)).toBeLessThan(
      pdfQuoteConfidenceFloor(40),
    );
    // Short quotes must be near-exact so a click never lands on coincidence.
    expect(pdfQuoteConfidenceFloor(40)).toBeGreaterThanOrEqual(0.85);
    expect(pdfQuoteConfidenceFloor(200)).toBeGreaterThan(0.5);
  });
});
