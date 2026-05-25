import { describe, expect, it } from "vitest";
import {
  navigateComposerPromptHistory,
  resetComposerPromptHistory,
  type ComposerPromptHistoryState,
} from "../../src/modules/composer-history";

function state(): ComposerPromptHistoryState {
  return {
    messages: [
      { role: "user", content: "first question" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second question" },
    ],
  };
}

describe("composer prompt history", () => {
  it("recalls the latest user prompt when the composer is empty", () => {
    const s = state();

    expect(navigateComposerPromptHistory(s, "", "previous")).toEqual({
      handled: true,
      value: "second question",
    });
  });

  it("walks backward and forward through recalled prompts", () => {
    const s = state();

    const latest = navigateComposerPromptHistory(s, "", "previous");
    const older = navigateComposerPromptHistory(s, latest.value, "previous");
    const newer = navigateComposerPromptHistory(s, older.value, "next");
    const empty = navigateComposerPromptHistory(s, newer.value, "next");

    expect(older.value).toBe("first question");
    expect(newer.value).toBe("second question");
    expect(empty.value).toBe("");
    expect(s.promptHistoryCursor).toBeUndefined();
  });

  it("does not hijack arrow keys for a manually typed draft", () => {
    const s = state();

    expect(navigateComposerPromptHistory(s, "draft", "previous")).toEqual({
      handled: false,
      value: "draft",
    });
  });

  it("resets an active history session when the draft changes", () => {
    const s = state();
    navigateComposerPromptHistory(s, "", "previous");

    resetComposerPromptHistory(s);

    expect(s.promptHistoryCursor).toBeUndefined();
    expect(s.promptHistoryDraft).toBeUndefined();
  });
});
