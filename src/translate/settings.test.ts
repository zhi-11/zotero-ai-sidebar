import { describe, expect, it, vi } from "vitest";
import {
  appendQuestionAnswerAnnotation,
  formatQuestionAnswer,
} from "./annotation";
import { normalizeTranslateSettings } from "./settings";
import {
  mechanicalTranslationKey,
  shouldInitiallyExpandAI,
  shouldPrefetchTranslations,
} from "./translate-mode";

describe("translate settings mode layout", () => {
  it("preserves a custom visible mode order and repairs a hidden default", () => {
    const settings = normalizeTranslateSettings({
      overlayModeOrder: ["question", "translate", "analyze", "explain"],
      visibleOverlayModes: ["question", "analyze"],
      defaultOverlayMode: "translate",
    });

    expect(settings.overlayModeOrder).toEqual([
      "question",
      "translate",
      "analyze",
      "explain",
    ]);
    expect(settings.visibleOverlayModes).toEqual(["question", "analyze"]);
    expect(settings.defaultOverlayMode).toBe("question");
  });

  it("keeps at least one mode visible", () => {
    const settings = normalizeTranslateSettings({
      visibleOverlayModes: [],
    });
    expect(settings.visibleOverlayModes).toEqual(["translate"]);
  });
});

describe("AI expansion policy", () => {
  it("does not force AI translation when entering question mode in manual mode", () => {
    expect(shouldInitiallyExpandAI("question", "manual", false, false)).toBe(
      false,
    );
  });

  it("still expands question mode for an explicit auto policy or cache hit", () => {
    expect(
      shouldInitiallyExpandAI("question", "always-open", false, false),
    ).toBe(true);
    expect(shouldInitiallyExpandAI("question", "manual", false, true)).toBe(
      true,
    );
  });

  it("prefetches only while AI is configured to stay open", () => {
    expect(shouldPrefetchTranslations("always-open", 1)).toBe(true);
    expect(shouldPrefetchTranslations("always-open", 3)).toBe(true);
    expect(shouldPrefetchTranslations("always-open", 100)).toBe(true);
    expect(shouldPrefetchTranslations("always-open", 0)).toBe(false);
    expect(shouldPrefetchTranslations("manual", 3)).toBe(false);
  });

  it("accepts any non-negative integer prefetch count", () => {
    expect(normalizeTranslateSettings({}).aiPrefetchCount).toBe(3);
    expect(
      normalizeTranslateSettings({ aiPrefetchCount: 0 }).aiPrefetchCount,
    ).toBe(0);
    expect(
      normalizeTranslateSettings({ aiPrefetchCount: 2 }).aiPrefetchCount,
    ).toBe(2);
    expect(
      normalizeTranslateSettings({ aiPrefetchCount: 3 }).aiPrefetchCount,
    ).toBe(3);
    expect(
      normalizeTranslateSettings({ aiPrefetchCount: 99 }).aiPrefetchCount,
    ).toBe(99);
    expect(
      normalizeTranslateSettings({ aiPrefetchCount: 12.8 }).aiPrefetchCount,
    ).toBe(12);
    expect(
      normalizeTranslateSettings({ aiPrefetchCount: -1 }).aiPrefetchCount,
    ).toBe(3);
  });

  it("keeps automatic question annotation opt-in", () => {
    expect(normalizeTranslateSettings({}).questionAutoAnnotation).toBe(false);
    expect(
      normalizeTranslateSettings({ questionAutoAnnotation: true })
        .questionAutoAnnotation,
    ).toBe(true);
  });
});

describe("machine translation window", () => {
  it("keeps cache entries separate for each machine engine", () => {
    expect(mechanicalTranslationKey("engine-a", " Same sentence. ")).not.toBe(
      mechanicalTranslationKey("engine-b", "Same sentence."),
    );
    expect(mechanicalTranslationKey("engine-a", " Same sentence. ")).toBe(
      mechanicalTranslationKey("engine-a", "Same sentence."),
    );
  });
});

describe("question annotation format", () => {
  it("uses append-friendly Q/A blocks", () => {
    expect(
      formatQuestionAnswer({
        question: " 这是什么意思？ ",
        answer: " 简短答案。 ",
      }),
    ).toBe("<b>Q：这是什么意思？</b>\nA：简短答案。");
  });

  it("appends only new Q/A blocks to an existing text annotation", async () => {
    const existing = {
      id: 7,
      annotationType: "highlight",
      annotationText: "Selected sentence.",
      annotationComment: "原有批注\n<b>Q：问题一</b>\nA：答案一",
      annotationPageLabel: "1",
      annotationPosition: JSON.stringify({
        pageIndex: 0,
        rects: [[1, 2, 3, 4]],
      }),
      saveTx: vi.fn(async () => undefined),
    };
    const saveFromJSON = vi.fn();
    Object.assign(globalThis, {
      Zotero: {
        Items: {
          getAsync: vi.fn(async () => ({
            id: 1,
            getAnnotations: () => [existing],
          })),
        },
        DataObjectUtilities: { generateKey: () => "KEY" },
        Annotations: { DEFAULT_COLOR: "#ffd400", saveFromJSON },
      },
    });

    const result = await appendQuestionAnswerAnnotation(
      {
        text: "Selected sentence.",
        attachmentID: 1,
        pageLabel: "1",
        pageIndex: 0,
        rects: [[1, 2, 3, 4]],
        sortIndex: "00001|000001|00000",
      },
      {
        entries: [
          { question: "问题一", answer: "答案一" },
          { question: "问题二", answer: "答案二" },
        ],
        type: "underline",
        color: "#ff0000",
      },
    );

    expect(result).toEqual({ id: 7, created: false, appended: 1 });
    expect(existing.annotationComment).toBe(
      "原有批注\n<b>Q：问题一</b>\nA：答案一\n<b>Q：问题二</b>\nA：答案二",
    );
    expect(existing.saveTx).toHaveBeenCalledOnce();
    expect(saveFromJSON).not.toHaveBeenCalled();
  });
});
