import { describe, expect, it } from "vitest";
import { renderMarkdownInto } from "../../src/modules/markdown-render";

function render(markdown: string): HTMLElement {
  const root = document.createElement("div");
  renderMarkdownInto(root, markdown);
  return root;
}

describe("renderMarkdownInto", () => {
  it("keeps indented list items nested under their parent item", () => {
    const root = render([
      "- Category: system paper",
      "- Context: related to VLAs; references:",
      "  - Black 2024 — pi0 flow VLA",
      "  - Pertsch 2025 — FAST tokenization",
      "- Correctness: check ablations",
    ].join("\n"));

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
    const root = render([
      "```text",
      "πθ(a_{t:t+H}, \\hat l | o_t, l)",
      "= πθ(a_{t:t+H} | o_t, \\hat l) πθ(\\hat l | o_t, l)",
      "```",
    ].join("\n"));

    const math = root.querySelector(".math-display") as HTMLElement | null;
    expect(math).not.toBeNull();
    expect(math?.dataset.latex).toContain("\\pi_\\theta");
    expect(root.querySelector("pre code")).toBeNull();
  });

  it("keeps ordinary fenced text blocks as code", () => {
    const root = render([
      "```text",
      "Run this command exactly:",
      "npm test",
      "```",
    ].join("\n"));

    expect(root.querySelector(".math-display")).toBeNull();
    expect(root.querySelector("pre code")?.textContent).toContain("npm test");
  });
});
