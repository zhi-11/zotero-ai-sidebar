export interface ComposerPromptHistoryMessage {
  role: string;
  content: string;
}

export interface ComposerPromptHistoryState {
  messages: ComposerPromptHistoryMessage[];
  promptHistoryCursor?: number;
  promptHistoryDraft?: string;
}

export type ComposerPromptHistoryDirection = "previous" | "next";

export interface ComposerPromptHistoryNavigation {
  handled: boolean;
  value: string;
}

export function resetComposerPromptHistory(
  state: ComposerPromptHistoryState,
): void {
  state.promptHistoryCursor = undefined;
  state.promptHistoryDraft = undefined;
}

export function navigateComposerPromptHistory(
  state: ComposerPromptHistoryState,
  currentValue: string,
  direction: ComposerPromptHistoryDirection,
): ComposerPromptHistoryNavigation {
  const prompts = userPromptHistory(state.messages);
  if (!prompts.length) return { handled: false, value: currentValue };

  const active = state.promptHistoryCursor != null;
  if (!active) {
    if (currentValue !== "" || direction === "next") {
      return { handled: false, value: currentValue };
    }
    state.promptHistoryDraft = currentValue;
    state.promptHistoryCursor = prompts.length;
  }

  const cursor = state.promptHistoryCursor ?? prompts.length;
  const delta = direction === "previous" ? -1 : 1;
  const nextCursor = Math.max(0, Math.min(prompts.length, cursor + delta));
  if (nextCursor === cursor) {
    return { handled: true, value: currentValue };
  }

  if (nextCursor === prompts.length) {
    const draft = state.promptHistoryDraft ?? "";
    resetComposerPromptHistory(state);
    return { handled: true, value: draft };
  }

  state.promptHistoryCursor = nextCursor;
  return { handled: true, value: prompts[nextCursor] };
}

function userPromptHistory(messages: ComposerPromptHistoryMessage[]): string[] {
  return messages
    .filter((message) => message.role === "user" && message.content.trim())
    .map((message) => message.content);
}
