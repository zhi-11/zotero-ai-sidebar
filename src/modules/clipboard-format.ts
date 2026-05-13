import { formatContextMarkdown } from "../context/message-format";
import type { Message } from "../providers/types";

export interface ClipboardConversationState {
  itemID: number | null;
  messages: Message[];
}

export function messageToClipboard(message: Message, includeDebugContext: boolean): string {
  if (!includeDebugContext) return message.content;

  const lines = [`## ${message.role === "user" ? "You" : "AI"}`, ""];
  lines.push(...formatContextMarkdown(message));
  const imageSummary = formatImageAttachmentSummary(message);
  if (imageSummary) lines.push(imageSummary, "");
  if (message.thinking) {
    lines.push("### 思考过程", "", message.thinking, "");
  }
  lines.push(message.content, "");
  return lines.join("\n");
}

export function formatConversationMarkdown(
  state: ClipboardConversationState,
  includeDebugContext: boolean,
  systemPrompt?: string,
): string {
  const item = state.itemID == null ? null : Zotero.Items.get(state.itemID);
  const title = item?.getField("title") || "未选择条目";
  const lines = [
    `# Zotero AI Chat - ${title}`,
    "",
    `- Item ID: ${state.itemID ?? "none"}`,
    `- Exported: ${new Date().toISOString()}`,
    "",
    ...formatItemIntroductionMarkdown(state.itemID, item),
  ];

  if (includeDebugContext && systemPrompt) {
    lines.push(
      "## System Prompt",
      "",
      "```",
      systemPrompt,
      "```",
      "",
    );
  }

  for (const message of state.messages) {
    lines.push(`## ${message.role === "user" ? "You" : "AI"}`, "");
    if (includeDebugContext) {
      lines.push(...formatContextMarkdown(message));
      const imageSummary = formatImageAttachmentSummary(message);
      if (imageSummary) lines.push(imageSummary, "");
      if (message.thinking) {
        lines.push("### 思考过程", "", message.thinking, "");
      }
    }
    lines.push(message.content, "");
  }

  return lines.join("\n");
}

function formatItemIntroductionMarkdown(
  itemID: number | null,
  item: Zotero.Item | false | null | undefined,
): string[] {
  if (itemID == null || !item) return [];
  const authors = item
    .getCreators()
    .map((creator) =>
      [creator.firstName, creator.lastName].filter(Boolean).join(" "),
    )
    .filter(Boolean);
  const fields = [
    ["标题", item.getField("title")],
    ["作者", authors.join(", ")],
    ["年份", parseYearString(item.getField("date"))],
    ["期刊/会议", item.getField("publicationTitle") || item.getField("conferenceName")],
    ["DOI", item.getField("DOI")],
    ["URL", item.getField("url")],
  ].filter(([, value]) => String(value ?? "").trim().length > 0);
  const tags = item
    .getTags()
    .map((tag) => tag.tag)
    .filter(Boolean);
  const abstract = item.getField("abstractNote")?.trim();
  const lines = ["## PDF 介绍", ""];
  for (const [label, value] of fields) {
    lines.push(`- ${label}: ${value}`);
  }
  if (tags.length) lines.push(`- 标签: ${tags.join(", ")}`);
  if (abstract) {
    lines.push("", "### 摘要", "", abstract);
  }
  lines.push("", "## 对话记录", "");
  return lines;
}

function parseYearString(date: string): string {
  return date.match(/\b(18|19|20|21)\d{2}\b/)?.[0] ?? "";
}

function formatImageAttachmentSummary(message: Message): string {
  if (!message.images?.length) return "";
  const lines = ["### 截图附件"];
  message.images.forEach((image, index) => {
    lines.push(
      `- ${index + 1}. ${image.name} (${image.mediaType}, ${formatBytes(image.size)})`,
    );
  });
  return lines.join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

