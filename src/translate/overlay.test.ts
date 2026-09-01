// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mountOverlay,
  shouldShowQuestionSaveButton,
  type OverlayHandle,
} from "./overlay";

declare const document: Document;

let handle: OverlayHandle | null = null;

afterEach(() => {
  handle?.destroy();
  handle = null;
  document.body!.replaceChildren();
  document.head!.replaceChildren();
});

describe("question overlay mode", () => {
  it("hides the manual annotation button when automatic writing is enabled", () => {
    expect(shouldShowQuestionSaveButton(false, 1)).toBe(true);
    expect(shouldShowQuestionSaveButton(true, 1)).toBe(false);
    expect(shouldShowQuestionSaveButton(false, 0)).toBe(false);
  });

  it("respects mode order and expands answers below the question input", () => {
    const page = document.createElement("div");
    page.className = "page";
    page.dataset.pageNumber = "1";
    document.body!.appendChild(page);
    page.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 600,
        bottom: 800,
        width: 600,
        height: 800,
        toJSON: () => ({}),
      }) as DOMRect;
    const ask = vi.fn();
    const next = vi.fn();

    handle = mountOverlay({
      iframeDoc: document,
      pageEl: page,
      rects: [[10, 20, 100, 30]],
      pageContent: {
        pageIndex: 0,
        pageLabel: "1",
        pageText: "Selected sentence.",
        normalizedText: "Selected sentence.",
        normalizedToOriginal: [],
        viewBox: [0, 0, 600, 800],
      },
      position: "below",
      size: "compact",
      initialMode: "question",
      enabledModes: ["question", "translate"],
      initialQuestionAnswers: [],
      actions: {
        onClose: vi.fn(),
        onAskQuestion: ask,
        onNext: next,
        hint: "",
      },
    });

    const tabNodes = handle.el.querySelectorAll(
      ".zai-translate-overlay__mode-tab",
    );
    const tabs: Array<string | null> = [];
    for (let index = 0; index < tabNodes.length; index++) {
      tabs.push((tabNodes.item(index) as HTMLElement).textContent);
    }
    expect(tabs).toEqual(["问答", "简译"]);

    const saveButton = handle.el.querySelector<HTMLButtonElement>(
      ".zai-question__save",
    )!;
    expect(saveButton.hidden).toBe(true);
    expect(
      saveButton.parentElement?.classList.contains("zai-question__form"),
    ).toBe(true);

    const input = handle.el.querySelector<HTMLInputElement>(
      ".zai-question__input",
    )!;
    input.value = "这句话的结论是什么？";
    input.form!.dispatchEvent(new Event("submit", { bubbles: true }));
    expect(ask).toHaveBeenCalledWith("这句话的结论是什么？");

    handle.setQuestionAnswers([
      { question: "这句话的结论是什么？", answer: "结论很简短。" },
    ]);
    expect(handle.el.querySelector(".zai-question__answer")?.textContent).toBe(
      "A：结论很简短。",
    );
    expect(saveButton.hidden).toBe(false);

    input.form!.dispatchEvent(new Event("submit", { bubbles: true }));
    expect(next).toHaveBeenCalledOnce();
  });
});
