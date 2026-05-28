import { describe, expect, it, beforeEach } from "vitest";
import {
  arxivFolderPath,
  writeArxivSource,
  hasArxivSource,
  readArxivMeta,
  readArxivTextFile,
  readArxivBibliographyFiles,
  matchFigureFile,
  mediaTypeForFigure,
  type ArxivMeta,
} from "../../src/context/arxiv-store";

let fs: Map<string, string | Uint8Array>;

beforeEach(() => {
  fs = new Map();
  Object.defineProperty(globalThis, "Zotero", {
    configurable: true,
    value: { DataDirectory: { dir: "/data" }, Profile: { dir: "/prof" } },
  });
  Object.defineProperty(globalThis, "IOUtils", {
    configurable: true,
    value: {
      makeDirectory: async () => undefined,
      writeUTF8: async (p: string, d: string) => void fs.set(p, d),
      write: async (p: string, d: Uint8Array) => void fs.set(p, d),
      readUTF8: async (p: string) => {
        if (!fs.has(p)) throw new Error("no entry");
        const value = fs.get(p);
        return typeof value === "string"
          ? value
          : new TextDecoder().decode(value);
      },
      exists: async (p: string) => fs.has(p),
    },
  });
});

const meta: ArxivMeta = {
  itemKey: "ABCD1234",
  arxivId: "2504.16054",
  fetchedAt: "2026-05-23T00:00:00.000Z",
  mainTexRelPath: "main.tex",
  status: "ok",
};

describe("arxiv-store", () => {
  it("builds a per-item folder path", () => {
    expect(arxivFolderPath("ABCD1234")).toBe(
      "/data/zotero-ai-sidebar/arxiv/ABCD1234",
    );
  });

  it("uses Windows separators for data-dir cache paths", async () => {
    Object.defineProperty(globalThis, "Zotero", {
      configurable: true,
      value: {
        DataDirectory: { dir: "C:\\Users\\admin\\Zotero" },
        Profile: { dir: "C:\\Users\\admin\\AppData\\Roaming\\Zotero" },
      },
    });

    await writeArxivSource(
      "ABCD1234",
      [{ path: "figures/robot.png", bytes: new Uint8Array([1, 2, 3]) }],
      meta,
    );

    expect(arxivFolderPath("ABCD1234")).toBe(
      "C:\\Users\\admin\\Zotero\\zotero-ai-sidebar\\arxiv\\ABCD1234",
    );
    expect(
      fs.has(
        "C:\\Users\\admin\\Zotero\\zotero-ai-sidebar\\arxiv\\ABCD1234\\source\\figures\\robot.png",
      ),
    ).toBe(true);
    expect(await readArxivTextFile("ABCD1234", "figures/robot.png")).toBe(
      "\u0001\u0002\u0003",
    );
  });

  it("writes source files + meta and round-trips meta (with files list)", async () => {
    await writeArxivSource(
      "ABCD1234",
      [
        {
          path: "main.tex",
          bytes: new TextEncoder().encode("\\documentclass{x}"),
        },
        { path: "figures/robot.png", bytes: new Uint8Array([1, 2, 3]) },
      ],
      meta,
    );
    expect(await readArxivMeta("ABCD1234")).toEqual({
      ...meta,
      files: ["main.tex", "figures/robot.png"],
    });
  });

  it("hasArxivSource is true after a write, false otherwise", async () => {
    expect(await hasArxivSource("NONE0000")).toBe(false);
    await writeArxivSource("ABCD1234", [], meta);
    expect(await hasArxivSource("ABCD1234")).toBe(true);
  });

  it("returns .bbl bibliography files before falling back to .bib", async () => {
    await writeArxivSource(
      "ABCD1234",
      [
        { path: "main.bbl", bytes: new TextEncoder().encode("compiled refs") },
        { path: "refs.bib", bytes: new TextEncoder().encode("bib refs") },
      ],
      meta,
    );

    expect(await readArxivBibliographyFiles("ABCD1234")).toEqual([
      { path: "main.bbl", text: "compiled refs" },
    ]);
  });

  it("falls back to .bib bibliography files when no .bbl exists", async () => {
    await writeArxivSource(
      "ABCD1234",
      [{ path: "refs.bib", bytes: new TextEncoder().encode("bib refs") }],
      meta,
    );

    expect(await readArxivBibliographyFiles("ABCD1234")).toEqual([
      { path: "refs.bib", text: "bib refs" },
    ]);
  });
});

describe("mediaTypeForFigure", () => {
  it("maps raster extensions to image/* types", () => {
    expect(mediaTypeForFigure("a/b/x.png")).toBe("image/png");
    expect(mediaTypeForFigure("X.JPG")).toBe("image/jpeg");
    expect(mediaTypeForFigure("y.jpeg")).toBe("image/jpeg");
    expect(mediaTypeForFigure("y.gif")).toBe("image/gif");
    expect(mediaTypeForFigure("y.WebP")).toBe("image/webp");
  });
  it("returns null for vector / unknown formats", () => {
    expect(mediaTypeForFigure("fig.pdf")).toBeNull();
    expect(mediaTypeForFigure("fig.eps")).toBeNull();
    expect(mediaTypeForFigure("no-extension")).toBeNull();
  });
});

describe("matchFigureFile", () => {
  const files = [
    "main.tex",
    "figures/robot_system_overview.png",
    "figures/attention_mask.png",
    "figures/Figure_3.pdf",
    "figures/visualize_eval_envs.pdf",
    "figures/rare_objects.jpg",
  ];

  it("matches by exact relative path", () => {
    expect(matchFigureFile(files, "figures/robot_system_overview.png")).toBe(
      "figures/robot_system_overview.png",
    );
  });
  it("matches by basename alone", () => {
    expect(matchFigureFile(files, "attention_mask.png")).toBe(
      "figures/attention_mask.png",
    );
  });
  it("matches by stem (no extension)", () => {
    expect(matchFigureFile(files, "rare_objects")).toBe(
      "figures/rare_objects.jpg",
    );
  });
  it("matches by case-insensitive substring", () => {
    expect(matchFigureFile(files, "ROBOT")).toBe(
      "figures/robot_system_overview.png",
    );
  });
  it("skips vector formats — Figure_3.pdf is unreachable", () => {
    expect(matchFigureFile(files, "Figure_3")).toBeNull();
    expect(matchFigureFile(files, "visualize_eval_envs.pdf")).toBeNull();
  });
  it("returns null when there are no supported raster files", () => {
    expect(matchFigureFile(["only.pdf", "more.eps"], "anything")).toBeNull();
  });
});
