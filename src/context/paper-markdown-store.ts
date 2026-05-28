// Per-paper repaired-markdown cache: papers/<itemKey>/{paper.md,figures/,meta.json}.
// Distinct from settings/paper-cache.ts (frozen full text). Binary figure
// writes and directory creation use IOUtils (a Firefox global in Zotero).

import { appendLocalPath } from "../utils/local-path";

export interface PaperBuildMeta {
  itemKey: string;
  pdfAttachmentID: number;
  pdfByteSize: number;
  pdfMtimeMs: number;
  pluginVersion: string;
  builtAt: string;
  formulaCount: number;
  lowConfidenceCount: number;
}

export interface PaperFigure {
  name: string; // e.g. "eq-p6-1.png"
  png: Uint8Array;
}

interface ZoteroGlobal {
  DataDirectory?: { dir?: string; path?: string };
  Profile: { dir: string };
}

interface IOUtilsLike {
  makeDirectory(
    path: string,
    options?: { ignoreExisting?: boolean },
  ): Promise<void>;
  writeUTF8(path: string, data: string): Promise<number>;
  write(path: string, data: Uint8Array): Promise<number>;
  readUTF8(path: string): Promise<string>;
}

function zotero(): ZoteroGlobal {
  return (globalThis as unknown as { Zotero: ZoteroGlobal }).Zotero;
}

function io(): IOUtilsLike {
  return (globalThis as unknown as { IOUtils: IOUtilsLike }).IOUtils;
}

function dataRoot(): string {
  const Z = zotero();
  return Z.DataDirectory?.dir ?? Z.DataDirectory?.path ?? Z.Profile.dir;
}

export function paperFolderPath(itemKey: string): string {
  return appendLocalPath(dataRoot(), "zotero-ai-sidebar", "papers", itemKey);
}

// Stale when there is no meta, or the source PDF's size/mtime changed.
export function isPaperCacheStale(
  meta: PaperBuildMeta | null,
  pdf: { byteSize: number; mtimeMs: number },
): boolean {
  if (!meta) return true;
  return meta.pdfByteSize !== pdf.byteSize || meta.pdfMtimeMs !== pdf.mtimeMs;
}

// Writes paper.md + figures/*.png + meta.json. Returns the folder path.
export async function writeRepairedPaper(
  itemKey: string,
  markdown: string,
  figures: PaperFigure[],
  meta: PaperBuildMeta,
): Promise<string> {
  const folder = paperFolderPath(itemKey);
  const IO = io();
  await IO.makeDirectory(folder, { ignoreExisting: true });
  await IO.makeDirectory(appendLocalPath(folder, "figures"), {
    ignoreExisting: true,
  });
  for (const figure of figures) {
    await IO.write(appendLocalPath(folder, "figures", figure.name), figure.png);
  }
  await IO.writeUTF8(appendLocalPath(folder, "paper.md"), markdown);
  await IO.writeUTF8(
    appendLocalPath(folder, "meta.json"),
    JSON.stringify(meta, null, 2),
  );
  return folder;
}

export async function readPaperMeta(
  itemKey: string,
): Promise<PaperBuildMeta | null> {
  try {
    const raw = await io().readUTF8(
      appendLocalPath(paperFolderPath(itemKey), "meta.json"),
    );
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as PaperBuildMeta)
      : null;
  } catch {
    return null;
  }
}
