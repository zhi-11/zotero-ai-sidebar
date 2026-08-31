import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCachedQuestionAnswers,
  normalizeQuestionAnswers,
  questionCacheKey,
  setCachedQuestionAnswers,
} from "./question-cache";

const files = new Map<string, string>();

beforeEach(() => {
  files.clear();
  Object.assign(globalThis, {
    Zotero: {
      DataDirectory: { dir: "C:\\Zotero" },
      Profile: { dir: "C:\\Profile" },
      File: {
        getContentsAsync: vi.fn(async (path: string) => {
          const value = files.get(path);
          if (value == null) throw new Error("not found");
          return value;
        }),
        putContentsAsync: vi.fn(async (path: string, value: string) => {
          files.set(path, value);
        }),
      },
    },
  });
});

describe("persistent question cache", () => {
  it("restores Q&A entries from the shared on-disk cache", async () => {
    const entries = [{ question: "问题", answer: "答案" }];
    await setCachedQuestionAnswers("Selected sentence.", entries, "model-a");

    await expect(
      getCachedQuestionAnswers("Selected sentence."),
    ).resolves.toEqual(entries);
    expect(questionCacheKey(" Selected   sentence. ")).toBe(
      questionCacheKey("selected sentence."),
    );
  });

  it("drops malformed cached records", () => {
    expect(
      normalizeQuestionAnswers([
        { question: " 有效问题 ", answer: " 有效答案 " },
        { question: "", answer: "无效" },
        null,
      ]),
    ).toEqual([{ question: "有效问题", answer: "有效答案" }]);
  });
});
