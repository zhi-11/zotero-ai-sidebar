import type { AgentTool, Message } from "../providers/types";

interface PinnedToolFilterOptions {
  fullTextHighlight?: boolean;
}

export function toolsForPinnedFullTextTurn(
  tools: AgentTool[],
  message: Message,
  options: PinnedToolFilterOptions = {},
): AgentTool[] {
  // An arXiv TOC front block is not the full paper; it is an index that
  // depends on tools for section bodies, figures, and full-source upgrades.
  if (message.context?.fullTextSource === "arxiv_toc") return tools;
  if (!shouldKeepToolsWithPinnedFullText(message, options)) {
    // arXiv full-text front blocks intentionally omit expanded .bbl/.bib
    // references, and PDF-visible equation numbers are compile-time metadata,
    // so keep deterministic lookup tools available on otherwise tool-free
    // whole-paper turns.
    if (message.context?.fullTextSource === "arxiv") {
      return tools.filter(
        (tool) =>
          tool.name === "arxiv_get_bibliography" ||
          tool.name === "arxiv_get_equation" ||
          tool.name === "arxiv_get_figure" ||
          tool.name === "arxiv_get_table",
      );
    }
    return [];
  }
  // With the whole paper pinned, read tools are redundant. Only keep tools
  // for explicit write/export workflows where the model must modify Zotero.
  const redundantWhenPinned = new Set([
    "chat_get_previous_context",
    "zotero_get_full_pdf",
  ]);
  return tools.filter((tool) => !redundantWhenPinned.has(tool.name));
}

function shouldKeepToolsWithPinnedFullText(
  message: Message,
  options: PinnedToolFilterOptions,
): boolean {
  if (options.fullTextHighlight) return true;
  const text = message.content.toLowerCase();
  return /标注|注释|高亮|划线|写入|保存|追加|加到.*笔记|保存.*笔记|新增文字|文字框|思维导图|脑图|mindmap|annotat|highlight|save|append|write.*note|mind ?map/.test(
    text,
  );
}
