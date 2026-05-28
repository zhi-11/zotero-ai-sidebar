// Per-Zotero-item frozen paper full text.
//
// Storage: a single JSON file in ~/Zotero/ (DataDirectory), keyed by
// `item:<itemID>`. Each entry freezes the extracted PDF full text so every
// send is byte-identical (a precondition for prompt-cache hits) and holds the
// per-item `pinned` toggle state.
//
// INVARIANT: writes are SERIALIZED via `writeQueue` (read-modify-write of the
// whole file). INVARIANT: reads treat the file as untrusted JSON — a malformed
// file yields "no entry" rather than throwing.
//
// REF: src/settings/chat-history.ts — same storage pattern.

import { appendLocalPath } from "../utils/local-path";

interface PaperCacheEntry {
  pinned: boolean;
  fullText: string;
  charCount: number;
  capturedAt: string;
  source: "full_pdf";
}

type PaperCacheFile = Record<string, PaperCacheEntry>;

interface ZoteroFileAPI {
  getContentsAsync(path: string, charset?: string): Promise<string>;
  putContentsAsync(path: string, contents: string): Promise<void>;
}

interface ZoteroGlobal {
  File: ZoteroFileAPI;
  Profile: { dir: string };
  DataDirectory?: { dir?: string; path?: string };
}

const CACHE_FILE = "zotero-ai-sidebar-paper-cache.json";
let writeQueue: Promise<void> = Promise.resolve();

function getZotero(): ZoteroGlobal {
  return (globalThis as unknown as { Zotero: ZoteroGlobal }).Zotero;
}

// ~/Zotero/ (DataDirectory) so the cache lives alongside chat history; fall
// back to the profile dir on older Zotero builds.
function cacheDir(): string {
  const Z = getZotero();
  return Z.DataDirectory?.dir ?? Z.DataDirectory?.path ?? Z.Profile.dir;
}

function cachePath(): string {
  return appendLocalPath(cacheDir(), CACHE_FILE);
}

function entryKey(itemID: number): string {
  return `item:${itemID}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Treat the file as untrusted: any malformed shape collapses to {}.
async function readFile(): Promise<PaperCacheFile> {
  try {
    const raw = await getZotero().File.getContentsAsync(cachePath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? (parsed as PaperCacheFile) : {};
  } catch {
    return {};
  }
}

async function writeFile(file: PaperCacheFile): Promise<void> {
  await getZotero().File.putContentsAsync(
    cachePath(),
    JSON.stringify(file, null, 2),
  );
}

function normalizeEntry(value: unknown): PaperCacheEntry | null {
  if (!isRecord(value)) return null;
  const fullText = typeof value.fullText === "string" ? value.fullText : "";
  return {
    pinned: value.pinned !== false,
    fullText,
    charCount:
      typeof value.charCount === "number" ? value.charCount : fullText.length,
    capturedAt: typeof value.capturedAt === "string" ? value.capturedAt : "",
    source: "full_pdf",
  };
}

async function loadEntry(itemID: number): Promise<PaperCacheEntry | null> {
  // A click on "原文" updates UI state before the disk write settles; reads
  // must queue behind pending writes so the next send sees the new flag.
  await writeQueue.catch(() => undefined);
  const file = await readFile();
  return normalizeEntry(file[entryKey(itemID)]);
}

// Read-modify-write a single entry under the serialized write queue.
function mutateEntry(
  itemID: number,
  mutate: (current: PaperCacheEntry | null) => PaperCacheEntry,
): Promise<void> {
  writeQueue = writeQueue
    .catch(() => undefined)
    .then(async () => {
      const file = await readFile();
      file[entryKey(itemID)] = mutate(normalizeEntry(file[entryKey(itemID)]));
      await writeFile(file);
    });
  return writeQueue;
}

// Freeze the extracted text. Preserves an existing `pinned` flag.
export function freezeFullText(
  itemID: number,
  fullText: string,
): Promise<void> {
  return mutateEntry(itemID, (current) => ({
    pinned: current?.pinned ?? true,
    fullText,
    charCount: fullText.length,
    capturedAt: new Date().toISOString(),
    source: "full_pdf",
  }));
}

// Returns the frozen text only when a usable cache exists (entry present,
// non-empty fullText); otherwise null — caller must extract and freeze.
export async function getFrozenFullText(
  itemID: number,
): Promise<string | null> {
  const entry = await loadEntry(itemID);
  return entry && entry.fullText.length > 0 ? entry.fullText : null;
}

export async function isPaperPinned(itemID: number): Promise<boolean> {
  // Default-on: only an explicit user toggle to false disables full-text pinning.
  return (await loadEntry(itemID))?.pinned !== false;
}

// Sets the toggle flag, preserving any frozen fullText.
export function setPaperPinned(itemID: number, pinned: boolean): Promise<void> {
  return mutateEntry(itemID, (current) => ({
    pinned,
    fullText: current?.fullText ?? "",
    charCount: current?.charCount ?? 0,
    capturedAt: current?.capturedAt ?? "",
    source: "full_pdf",
  }));
}
