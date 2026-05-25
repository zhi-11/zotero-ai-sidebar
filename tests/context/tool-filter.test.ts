import { describe, expect, it } from "vitest";
import { toolsForPinnedFullTextTurn } from "../../src/context/tool-filter";
import type { AgentTool, Message } from "../../src/providers/types";

function tool(name: string): AgentTool {
  return {
    name,
    description: name,
    parameters: {},
    execute: async () => ({ output: "" }),
  };
}

const tools = [
  tool("chat_get_previous_context"),
  tool("zotero_get_full_pdf"),
  tool("arxiv_list_sections"),
  tool("arxiv_get_section"),
  tool("arxiv_get_figure"),
  tool("arxiv_get_table"),
  tool("arxiv_get_equation"),
  tool("arxiv_get_bibliography"),
  tool("zotero_append_to_note"),
];

function userMessage(
  content: string,
  context: Message["context"] = {},
): Message {
  return { role: "user", content, context };
}

describe("toolsForPinnedFullTextTurn", () => {
  it("keeps all tools when the pinned front block is only an arXiv TOC", () => {
    const result = toolsForPinnedFullTextTurn(
      tools,
      userMessage("总结第 3 章", { fullTextSource: "arxiv_toc" }),
    );

    expect(result.map((t) => t.name)).toEqual(tools.map((t) => t.name));
  });

  it("drops tools for an ordinary whole-paper pinned turn", () => {
    const result = toolsForPinnedFullTextTurn(
      tools,
      userMessage("总结这篇论文", { fullTextSource: "pdf" }),
    );

    expect(result).toEqual([]);
  });

  it("keeps deterministic arXiv lookups for arXiv full-text turns", () => {
    const result = toolsForPinnedFullTextTurn(
      tools,
      userMessage("总结这篇论文", { fullTextSource: "arxiv" }),
    );

    expect(result.map((t) => t.name)).toEqual([
      "arxiv_get_figure",
      "arxiv_get_table",
      "arxiv_get_equation",
      "arxiv_get_bibliography",
    ]);
  });

  it("keeps write/export tools for explicit write requests", () => {
    const result = toolsForPinnedFullTextTurn(
      tools,
      userMessage("把总结追加到笔记", { fullTextSource: "pdf" }),
    );

    expect(result.map((t) => t.name)).toEqual([
      "arxiv_list_sections",
      "arxiv_get_section",
      "arxiv_get_figure",
      "arxiv_get_table",
      "arxiv_get_equation",
      "arxiv_get_bibliography",
      "zotero_append_to_note",
    ]);
  });
});
