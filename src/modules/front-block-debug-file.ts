import type { MessageContext } from "../context/types";
import { appendLocalPath } from "../utils/local-path";

export type FrontBlockDebugSource = NonNullable<
  MessageContext["fullTextSource"]
>;

interface IOUtilsLike {
  makeDirectory(
    path: string,
    options?: { ignoreExisting?: boolean },
  ): Promise<void>;
  exists(path: string): Promise<boolean>;
  writeUTF8(path: string, data: string): Promise<unknown>;
}

interface ZoteroDataRootLike {
  DataDirectory?: { dir?: string; path?: string };
  Profile?: { dir?: string };
}

export interface SaveFrontBlockDebugFileArgs {
  enabled: boolean;
  itemID: number | null;
  source: FrontBlockDebugSource;
  text: string;
}

// Saves the exact front block once per item/source/content hash. The filename
// is deterministic so repeated debug sends of the same paper do not create
// duplicate files.
export async function saveFrontBlockDebugFileOnce(
  args: SaveFrontBlockDebugFileArgs,
): Promise<string | undefined> {
  if (!args.enabled || !args.text) return undefined;
  const root = zoteroDataRoot();
  const IO = ioUtils();
  if (!root || !IO) return undefined;

  const folder = appendLocalPath(
    root,
    "zotero-ai-sidebar",
    "prompt-front-blocks",
  );
  const hash = stableHash(args.text);
  const item = args.itemID == null ? "none" : String(args.itemID);
  const fileName = [
    `item-${safeFilePart(item)}`,
    safeFilePart(args.source),
    `${args.text.length}chars`,
    hash,
  ].join("-");
  const path = appendLocalPath(folder, `${fileName}.txt`);

  await IO.makeDirectory(folder, { ignoreExisting: true });
  if (!(await IO.exists(path))) {
    await IO.writeUTF8(path, args.text);
  }
  return path;
}

function zoteroDataRoot(): string | null {
  const Z = (globalThis as unknown as { Zotero?: ZoteroDataRootLike }).Zotero;
  return (
    Z?.DataDirectory?.dir ?? Z?.DataDirectory?.path ?? Z?.Profile?.dir ?? null
  );
}

function ioUtils(): IOUtilsLike | null {
  return (globalThis as unknown as { IOUtils?: IOUtilsLike }).IOUtils ?? null;
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_");
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
