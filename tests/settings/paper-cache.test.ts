import { beforeEach, describe, expect, it } from "vitest";
import {
  freezeFullText,
  getFrozenFullText,
  isPaperPinned,
  setPaperPinned,
} from "../../src/settings/paper-cache";

let stored = "{}";

beforeEach(() => {
  stored = "{}";
  Object.defineProperty(globalThis, "Zotero", {
    configurable: true,
    value: {
      Profile: { dir: "/tmp/zotero-profile" },
      DataDirectory: { dir: "/tmp/zotero-data" },
      File: {
        getContentsAsync: async () => stored,
        putContentsAsync: async (_path: string, contents: string) => {
          stored = contents;
        },
      },
    },
  });
});

describe("paper cache", () => {
  it("freezes full text and reads it back byte-identical", async () => {
    await freezeFullText(7, "PAPER BODY");
    expect(await getFrozenFullText(7)).toBe("PAPER BODY");
  });

  it("returns null when no usable cache exists", async () => {
    expect(await getFrozenFullText(7)).toBeNull();
  });

  it("treats an empty fullText as no usable cache", async () => {
    await freezeFullText(7, "");
    expect(await getFrozenFullText(7)).toBeNull();
  });

  it("defaults the paper full text toggle to pinned", async () => {
    expect(await isPaperPinned(7)).toBe(true);
  });

  it("persists the pinned flag independently of the frozen text", async () => {
    await freezeFullText(7, "PAPER BODY");
    expect(await isPaperPinned(7)).toBe(true);
    await setPaperPinned(7, true);
    expect(await isPaperPinned(7)).toBe(true);
    expect(await getFrozenFullText(7)).toBe("PAPER BODY");
  });

  it("keeps the frozen text when the toggle is turned off", async () => {
    await freezeFullText(7, "PAPER BODY");
    await setPaperPinned(7, true);
    await setPaperPinned(7, false);
    expect(await getFrozenFullText(7)).toBe("PAPER BODY");
    expect(await isPaperPinned(7)).toBe(false);
  });

  it("discards a malformed cache file", async () => {
    stored = "not json";
    expect(await getFrozenFullText(7)).toBeNull();
    expect(await isPaperPinned(7)).toBe(true);
  });

  it("serializes concurrent writes without losing either mutation", async () => {
    const a = freezeFullText(7, "TEXT A");
    const b = setPaperPinned(7, true);
    await Promise.all([a, b]);
    expect(await getFrozenFullText(7)).toBe("TEXT A");
    expect(await isPaperPinned(7)).toBe(true);
  });

  it("waits for a pending toggle write before reading the pinned flag", async () => {
    let releaseWrite: (() => void) | undefined;
    Object.defineProperty(globalThis, "Zotero", {
      configurable: true,
      value: {
        Profile: { dir: "/tmp/zotero-profile" },
        DataDirectory: { dir: "/tmp/zotero-data" },
        File: {
          getContentsAsync: async () => stored,
          putContentsAsync: async (_path: string, contents: string) => {
            await new Promise<void>((resolve) => {
              releaseWrite = resolve;
            });
            stored = contents;
          },
        },
      },
    });

    const write = setPaperPinned(7, true);
    const read = isPaperPinned(7);
    let readSettled = false;
    void read.then(() => {
      readSettled = true;
    });

    for (let i = 0; i < 5 && !releaseWrite; i++) {
      await Promise.resolve();
    }
    expect(releaseWrite).toBeTypeOf("function");
    expect(readSettled).toBe(false);

    releaseWrite!();
    await write;
    await expect(read).resolves.toBe(true);
  });

  it("uses Windows separators when Zotero data directory is a Windows path", async () => {
    const paths: string[] = [];
    Object.defineProperty(globalThis, "Zotero", {
      configurable: true,
      value: {
        Profile: {
          dir: "C:\\Users\\admin\\AppData\\Roaming\\Zotero\\Zotero\\Profiles\\uerjpa0m.default",
        },
        DataDirectory: { dir: "C:\\Users\\admin\\Zotero" },
        File: {
          getContentsAsync: async (path: string) => {
            paths.push(path);
            return stored;
          },
          putContentsAsync: async (path: string, contents: string) => {
            paths.push(path);
            stored = contents;
          },
        },
      },
    });

    await setPaperPinned(7, true);

    expect(paths).toEqual([
      "C:\\Users\\admin\\Zotero\\zotero-ai-sidebar-paper-cache.json",
      "C:\\Users\\admin\\Zotero\\zotero-ai-sidebar-paper-cache.json",
    ]);
  });
});
