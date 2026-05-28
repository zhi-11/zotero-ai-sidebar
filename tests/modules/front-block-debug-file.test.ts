import { beforeEach, describe, expect, it } from "vitest";
import { saveFrontBlockDebugFileOnce } from "../../src/modules/front-block-debug-file";

let files: Map<string, string>;
let writes: number;

beforeEach(() => {
  files = new Map();
  writes = 0;
  Object.defineProperty(globalThis, "Zotero", {
    configurable: true,
    value: {
      DataDirectory: { dir: "/tmp/zotero-data" },
      Profile: { dir: "/tmp/zotero-profile" },
    },
  });
  Object.defineProperty(globalThis, "IOUtils", {
    configurable: true,
    value: {
      makeDirectory: async () => undefined,
      exists: async (path: string) => files.has(path),
      writeUTF8: async (path: string, data: string) => {
        files.set(path, data);
        writes += 1;
      },
    },
  });
});

describe("saveFrontBlockDebugFileOnce", () => {
  it("uses a deterministic path and does not rewrite duplicate content", async () => {
    const first = await saveFrontBlockDebugFileOnce({
      enabled: true,
      itemID: 1434,
      source: "arxiv",
      text: "FULL PAPER TEXT",
    });
    const second = await saveFrontBlockDebugFileOnce({
      enabled: true,
      itemID: 1434,
      source: "arxiv",
      text: "FULL PAPER TEXT",
    });

    expect(first).toBe(second);
    expect(first).toContain(
      "/tmp/zotero-data/zotero-ai-sidebar/prompt-front-blocks/item-1434-arxiv-15chars-",
    );
    expect(files.get(first!)).toBe("FULL PAPER TEXT");
    expect(writes).toBe(1);
  });

  it("uses Windows separators when the Zotero data directory is a Windows path", async () => {
    Object.defineProperty(globalThis, "Zotero", {
      configurable: true,
      value: {
        DataDirectory: { dir: "C:\\Users\\admin\\Zotero" },
        Profile: { dir: "C:\\Users\\admin\\AppData\\Roaming\\Zotero" },
      },
    });

    const path = await saveFrontBlockDebugFileOnce({
      enabled: true,
      itemID: 1434,
      source: "pdf",
      text: "FULL PAPER TEXT",
    });

    expect(path).toContain(
      "C:\\Users\\admin\\Zotero\\zotero-ai-sidebar\\prompt-front-blocks\\item-1434-pdf-15chars-",
    );
    expect(files.get(path!)).toBe("FULL PAPER TEXT");
  });

  it("does nothing when debug saving is disabled", async () => {
    const path = await saveFrontBlockDebugFileOnce({
      enabled: false,
      itemID: 1434,
      source: "pdf",
      text: "FULL PAPER TEXT",
    });

    expect(path).toBeUndefined();
    expect(writes).toBe(0);
  });
});
