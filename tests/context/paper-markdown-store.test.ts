import { describe, expect, it, beforeEach } from "vitest";
import {
  paperFolderPath,
  isPaperCacheStale,
  writeRepairedPaper,
  readPaperMeta,
  type PaperBuildMeta,
} from "../../src/context/paper-markdown-store";

function meta(over: Partial<PaperBuildMeta> = {}): PaperBuildMeta {
  return {
    itemKey: "ABCD1234",
    pdfAttachmentID: 7,
    pdfByteSize: 1000,
    pdfMtimeMs: 5000,
    pluginVersion: "0.4.2",
    builtAt: "2026-05-23T00:00:00.000Z",
    formulaCount: 3,
    lowConfidenceCount: 0,
    ...over,
  };
}

describe("paper-markdown-store pure helpers", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "Zotero", {
      configurable: true,
      value: { DataDirectory: { dir: "/data" }, Profile: { dir: "/prof" } },
    });
  });

  it("builds a per-item folder path under the data dir", () => {
    expect(paperFolderPath("ABCD1234")).toBe(
      "/data/zotero-ai-sidebar/papers/ABCD1234",
    );
  });

  it("uses Windows separators for data-dir paper paths", () => {
    Object.defineProperty(globalThis, "Zotero", {
      configurable: true,
      value: {
        DataDirectory: { dir: "C:\\Users\\admin\\Zotero" },
        Profile: { dir: "C:\\Users\\admin\\AppData\\Roaming\\Zotero" },
      },
    });

    expect(paperFolderPath("ABCD1234")).toBe(
      "C:\\Users\\admin\\Zotero\\zotero-ai-sidebar\\papers\\ABCD1234",
    );
  });

  it("treats a missing meta as stale", () => {
    expect(isPaperCacheStale(null, { byteSize: 1000, mtimeMs: 5000 })).toBe(
      true,
    );
  });

  it("treats matching size+mtime as fresh", () => {
    expect(isPaperCacheStale(meta(), { byteSize: 1000, mtimeMs: 5000 })).toBe(
      false,
    );
  });

  it("treats a changed pdf size or mtime as stale", () => {
    expect(isPaperCacheStale(meta(), { byteSize: 2000, mtimeMs: 5000 })).toBe(
      true,
    );
    expect(isPaperCacheStale(meta(), { byteSize: 1000, mtimeMs: 9999 })).toBe(
      true,
    );
  });
});

describe("paper-markdown-store I/O round-trip", () => {
  let fs: Map<string, string | Uint8Array>;

  beforeEach(() => {
    Object.defineProperty(globalThis, "Zotero", {
      configurable: true,
      value: { DataDirectory: { dir: "/data" }, Profile: { dir: "/prof" } },
    });
    fs = new Map<string, string | Uint8Array>();
    Object.defineProperty(globalThis, "IOUtils", {
      configurable: true,
      value: {
        makeDirectory: async () => undefined,
        writeUTF8: async (path: string, data: string) => {
          fs.set(path, data);
          return data.length;
        },
        write: async (path: string, data: Uint8Array) => {
          fs.set(path, data);
          return data.length;
        },
        readUTF8: async (path: string) => {
          if (!fs.has(path)) throw new Error(`no entry: ${path}`);
          return fs.get(path) as string;
        },
      },
    });
  });

  it("writes paper.md + figures + meta.json and round-trips meta", async () => {
    const folder = await writeRepairedPaper(
      "ABCD1234",
      "# md body",
      [{ name: "eq-p1-1.png", png: new Uint8Array([1, 2, 3]) }],
      meta(),
    );

    expect(folder).toBe(paperFolderPath("ABCD1234"));
    expect(fs.get(`${folder}/paper.md`)).toBe("# md body");
    expect(fs.get(`${folder}/figures/eq-p1-1.png`)).toEqual(
      new Uint8Array([1, 2, 3]),
    );

    const roundTripped = await readPaperMeta("ABCD1234");
    expect(roundTripped).toEqual(meta());
  });

  it("writes repaired paper files with Windows separators", async () => {
    Object.defineProperty(globalThis, "Zotero", {
      configurable: true,
      value: {
        DataDirectory: { dir: "C:\\Users\\admin\\Zotero" },
        Profile: { dir: "C:\\Users\\admin\\AppData\\Roaming\\Zotero" },
      },
    });

    const folder = await writeRepairedPaper(
      "ABCD1234",
      "# md body",
      [{ name: "eq-p1-1.png", png: new Uint8Array([1, 2, 3]) }],
      meta(),
    );

    expect(folder).toBe(
      "C:\\Users\\admin\\Zotero\\zotero-ai-sidebar\\papers\\ABCD1234",
    );
    expect(fs.get(`${folder}\\paper.md`)).toBe("# md body");
    expect(fs.get(`${folder}\\figures\\eq-p1-1.png`)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(await readPaperMeta("ABCD1234")).toEqual(meta());
  });

  it("returns null when meta.json cannot be read", async () => {
    expect(await readPaperMeta("ABCD1234")).toBeNull();
  });
});
