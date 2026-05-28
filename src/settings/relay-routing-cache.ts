// Per-paper relay-routing salt for OpenAI sticky-session backends.
//
// Some self-hosted OpenAI relays (e.g. `claude-relay-service`) hash the
// `prompt_cache_key` (and matching `session_id` header) to bind the request
// to a fixed backend Codex account. When the bound account is unhealthy
// (quota / token / network) the relay returns HTTP 5xx. We auto-retry with
// a bumped salt — that changes the hash, lands the request on a different
// backend — and persist the salt that finally succeeded so subsequent
// requests for the same paper keep the sticky-session benefit (long-prefix
// prompt cache hits build up on that account).
//
// Storage: a single JSON file in ~/Zotero/ (DataDirectory), keyed by
// `<presetID>|<model>|<itemKey or 'global'>`. Each entry is just
// `{ salt: number, lastSuccessAt: ISO string }`.
//
// INVARIANT: writes are SERIALIZED via `writeQueue` (same pattern as
// paper-cache.ts / chat-history.ts). INVARIANT: reads treat the file as
// untrusted JSON — malformed shape collapses to "no entry" rather than
// throwing. INVARIANT: this file is NOT included in the WebDAV sync
// snapshot — two machines may map the same paper to different healthy
// accounts (the relay's backend pool state and the client's network path
// both vary), so each machine maintains its own routing locally.

import { appendLocalPath } from "../utils/local-path";

export interface RelayRoutingEntry {
  salt: number;
  lastSuccessAt: string;
}

type RelayRoutingFile = Record<string, RelayRoutingEntry>;

interface ZoteroFileAPI {
  getContentsAsync(path: string, charset?: string): Promise<string>;
  putContentsAsync(path: string, contents: string): Promise<void>;
}

interface ZoteroGlobal {
  File: ZoteroFileAPI;
  Profile: { dir: string };
  DataDirectory?: { dir?: string; path?: string };
}

const CACHE_FILE = "zotero-ai-sidebar-relay-routing.json";
let writeQueue: Promise<void> = Promise.resolve();

function getZotero(): ZoteroGlobal {
  return (globalThis as unknown as { Zotero: ZoteroGlobal }).Zotero;
}

function cacheDir(): string {
  const Z = getZotero();
  return Z.DataDirectory?.dir ?? Z.DataDirectory?.path ?? Z.Profile.dir;
}

function cachePath(): string {
  return appendLocalPath(cacheDir(), CACHE_FILE);
}

// Stable composite key: preset + model + paper. `itemKey` is the Zotero
// 8-char item key (e.g. FQRVCCJN) when chatting against a specific paper,
// or null for a global chat. We use `|` as the separator since it cannot
// appear in any of the three components.
export function routingEntryKey(
  presetId: string,
  model: string,
  itemKey: string | null,
): string {
  const safePreset = presetId || "preset";
  const safeModel = model || "model";
  const safeItem = itemKey && itemKey.length > 0 ? itemKey : "global";
  return `${safePreset}|${safeModel}|${safeItem}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Treat the file as untrusted: any malformed shape collapses to {}.
async function readFile(): Promise<RelayRoutingFile> {
  try {
    const raw = await getZotero().File.getContentsAsync(cachePath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? (parsed as RelayRoutingFile) : {};
  } catch {
    return {};
  }
}

async function writeFile(file: RelayRoutingFile): Promise<void> {
  await getZotero().File.putContentsAsync(
    cachePath(),
    JSON.stringify(file, null, 2),
  );
}

function normalizeEntry(value: unknown): RelayRoutingEntry | null {
  if (!isRecord(value)) return null;
  const salt =
    typeof value.salt === "number" && Number.isFinite(value.salt)
      ? Math.max(0, Math.floor(value.salt))
      : 0;
  const lastSuccessAt =
    typeof value.lastSuccessAt === "string" ? value.lastSuccessAt : "";
  return { salt, lastSuccessAt };
}

// Returns the salt that previously succeeded for this (preset, model,
// itemKey) tuple, or 0 when no prior success is recorded. Always resolves
// — never throws.
export async function loadRelaySalt(
  presetId: string,
  model: string,
  itemKey: string | null,
): Promise<number> {
  // Reads must queue behind pending writes so a fresh persist is observed.
  await writeQueue.catch(() => undefined);
  const file = await readFile();
  return normalizeEntry(file[routingEntryKey(presetId, model, itemKey)])?.salt ?? 0;
}

// Records the salt that just produced a successful response. Subsequent
// requests for the same paper will reuse this salt, so the OpenAI prompt
// cache builds up on the bound backend account.
export function persistRelaySalt(
  presetId: string,
  model: string,
  itemKey: string | null,
  salt: number,
): Promise<void> {
  const key = routingEntryKey(presetId, model, itemKey);
  const safeSalt = Math.max(0, Math.floor(salt));
  writeQueue = writeQueue
    .catch(() => undefined)
    .then(async () => {
      const file = await readFile();
      file[key] = {
        salt: safeSalt,
        lastSuccessAt: new Date().toISOString(),
      };
      await writeFile(file);
    });
  return writeQueue;
}
