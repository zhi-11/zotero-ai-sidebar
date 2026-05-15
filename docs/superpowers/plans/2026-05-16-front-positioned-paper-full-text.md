# Front-Positioned Paper Full Text — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Whenever the paper full text enters a chat request — via a new per-item manual toggle OR via the model's own `zotero_get_full_pdf` fetch — render it at one canonical position (immediately after the system prompt, before conversation history), sourced from a frozen cache file so it is byte-identical turn to turn.

**Architecture:** A "front block" the provider prepends after the system prompt. Two triggers feed it: the manual toggle passes `ProviderStreamOptions.pinnedFullText` up front; the `zotero_get_full_pdf` tool returns `ToolExecutionResult.frontBlock` mid-loop. A new `paper-cache.ts` module owns a `~/Zotero/zotero-ai-sidebar-paper-cache.json` file that freezes the extracted text. Default model-driven behavior is unchanged when no front block is set.

**Tech Stack:** TypeScript, Vitest, Zotero plugin runtime (Gecko), OpenAI Responses + Chat Completions APIs, Anthropic Messages API.

**Spec:** `docs/superpowers/specs/2026-05-16-manual-paper-pin-design.md`

---

## File Structure

- `src/settings/paper-cache.ts` — NEW. Owns the paper-cache JSON file: load/save entry, pinned flag, freeze full text, read frozen text. Mirrors `chat-history.ts`.
- `src/providers/types.ts` — MODIFY. `ProviderStreamOptions.pinnedFullText`, `ToolExecutionResult.frontBlock`.
- `src/providers/anthropic.ts` — MODIFY. Render the front block as a second `system` content block with 1h-TTL `cache_control`.
- `src/providers/openai.ts` — MODIFY. Front-block slot in `streamWithTools` and `streamChatCompletions`.
- `src/context/agent-tools.ts` — MODIFY. `zotero_get_full_pdf` freezes/reads the cache and returns `frontBlock` + an ack instead of the buried full text.
- `src/modules/sidebar.ts` — MODIFY. Orchestrator passes `pinnedFullText`; new `renderPaperPinSwitcher` toggle; `PanelState.paperPinned`.
- `addon/content/sidebar.css` — MODIFY. Toggle button styling (reuses `.web-search-trigger` rules).
- `tests/settings/paper-cache.test.ts` — NEW.

Toggle label/tooltip strings are hardcoded in `sidebar.ts` (the existing "联网" switcher hardcodes its strings; no `.ftl` change).

---

## Task 1: paper-cache.ts cache-file module

**Files:**
- Create: `src/settings/paper-cache.ts`
- Test: `tests/settings/paper-cache.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/settings/paper-cache.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from 'vitest';
import {
  freezeFullText,
  getFrozenFullText,
  isPaperPinned,
  setPaperPinned,
} from '../../src/settings/paper-cache';

let stored = '{}';

beforeEach(() => {
  stored = '{}';
  Object.defineProperty(globalThis, 'Zotero', {
    configurable: true,
    value: {
      Profile: { dir: '/tmp/zotero-profile' },
      DataDirectory: { dir: '/tmp/zotero-data' },
      File: {
        getContentsAsync: async () => stored,
        putContentsAsync: async (_path: string, contents: string) => {
          stored = contents;
        },
      },
    },
  });
});

describe('paper cache', () => {
  it('freezes full text and reads it back byte-identical', async () => {
    await freezeFullText(7, 'PAPER BODY', 'full_pdf');
    expect(await getFrozenFullText(7)).toBe('PAPER BODY');
  });

  it('returns null when no usable cache exists', async () => {
    expect(await getFrozenFullText(7)).toBeNull();
  });

  it('treats an empty fullText as no usable cache', async () => {
    await freezeFullText(7, '', 'full_pdf');
    expect(await getFrozenFullText(7)).toBeNull();
  });

  it('persists the pinned flag independently of the frozen text', async () => {
    await freezeFullText(7, 'PAPER BODY', 'full_pdf');
    expect(await isPaperPinned(7)).toBe(false);
    await setPaperPinned(7, true);
    expect(await isPaperPinned(7)).toBe(true);
    expect(await getFrozenFullText(7)).toBe('PAPER BODY');
  });

  it('keeps the frozen text when the toggle is turned off', async () => {
    await freezeFullText(7, 'PAPER BODY', 'full_pdf');
    await setPaperPinned(7, true);
    await setPaperPinned(7, false);
    expect(await getFrozenFullText(7)).toBe('PAPER BODY');
  });

  it('discards a malformed cache file', async () => {
    stored = 'not json';
    expect(await getFrozenFullText(7)).toBeNull();
    expect(await isPaperPinned(7)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/settings/paper-cache.test.ts`
Expected: FAIL — cannot resolve `../../src/settings/paper-cache`.

- [ ] **Step 3: Write the implementation**

Create `src/settings/paper-cache.ts`:

```typescript
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

interface PaperCacheEntry {
  pinned: boolean;
  fullText: string;
  charCount: number;
  capturedAt: string;
  source: 'full_pdf';
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

const CACHE_FILE = 'zotero-ai-sidebar-paper-cache.json';
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
  return `${cacheDir()}/${CACHE_FILE}`;
}

function entryKey(itemID: number): string {
  return `item:${itemID}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Treat the file as untrusted: any malformed shape collapses to {}.
async function readFile(): Promise<PaperCacheFile> {
  try {
    const raw = await getZotero().File.getContentsAsync(cachePath(), 'utf-8');
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
  const fullText = typeof value.fullText === 'string' ? value.fullText : '';
  return {
    pinned: value.pinned === true,
    fullText,
    charCount: typeof value.charCount === 'number' ? value.charCount : fullText.length,
    capturedAt: typeof value.capturedAt === 'string' ? value.capturedAt : '',
    source: 'full_pdf',
  };
}

async function loadEntry(itemID: number): Promise<PaperCacheEntry | null> {
  const file = await readFile();
  return normalizeEntry(file[entryKey(itemID)]);
}

// Read-modify-write a single entry under the serialized write queue.
function mutateEntry(
  itemID: number,
  mutate: (current: PaperCacheEntry | null) => PaperCacheEntry,
): Promise<void> {
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
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
  source: 'full_pdf',
): Promise<void> {
  return mutateEntry(itemID, (current) => ({
    pinned: current?.pinned ?? false,
    fullText,
    charCount: fullText.length,
    capturedAt: new Date().toISOString(),
    source,
  }));
}

// Returns the frozen text only when a usable cache exists (entry present,
// non-empty fullText); otherwise null — caller must extract and freeze.
export async function getFrozenFullText(itemID: number): Promise<string | null> {
  const entry = await loadEntry(itemID);
  return entry && entry.fullText.length > 0 ? entry.fullText : null;
}

export async function isPaperPinned(itemID: number): Promise<boolean> {
  return (await loadEntry(itemID))?.pinned === true;
}

// Sets the toggle flag, preserving any frozen fullText.
export function setPaperPinned(itemID: number, pinned: boolean): Promise<void> {
  return mutateEntry(itemID, (current) => ({
    pinned,
    fullText: current?.fullText ?? '',
    charCount: current?.charCount ?? 0,
    capturedAt: current?.capturedAt ?? '',
    source: 'full_pdf',
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/settings/paper-cache.test.ts`
Expected: PASS — all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/settings/paper-cache.ts tests/settings/paper-cache.test.ts
git commit -m "feat: add paper-cache module for frozen full text"
```

---

## Task 2: Extend provider type contracts

**Files:**
- Modify: `src/providers/types.ts:108-114` (`ProviderStreamOptions`), `src/providers/types.ts:94-98` (`ToolExecutionResult`)

- [ ] **Step 1: Add `pinnedFullText` to `ProviderStreamOptions`**

In `src/providers/types.ts`, change the `ProviderStreamOptions` interface:

```typescript
export interface ProviderStreamOptions {
  tools?: AgentTool[];
  maxToolIterations?: number;
  permissionMode?: AgentPermissionMode;
  toolSettings?: ToolSettings;
  promptCacheKey?: string;
  // Raw paper full text to pin as a front block (after the system prompt,
  // before conversation history). Set by the manual "原文" toggle.
  pinnedFullText?: string;
}
```

- [ ] **Step 2: Add `frontBlock` to `ToolExecutionResult`**

In `src/providers/types.ts`, change the `ToolExecutionResult` interface:

```typescript
export interface ToolExecutionResult {
  output: string;
  summary?: string;
  context?: MessageContext;
  // Raw paper full text a tool wants pinned as the front block for the rest
  // of this turn's tool loop. Set by zotero_get_full_pdf.
  frontBlock?: string;
}
```

- [ ] **Step 3: Verify the project still type-checks**

Run: `npm run build`
Expected: PASS (the new fields are optional; no existing code breaks).

- [ ] **Step 4: Commit**

```bash
git add src/providers/types.ts
git commit -m "feat: add pinnedFullText and frontBlock to provider contracts"
```

---

## Task 3: Anthropic front block

**Files:**
- Modify: `src/providers/anthropic.ts:18-43`
- Test: `tests/providers/anthropic.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/providers/anthropic.test.ts` (a `toAnthropicSystem` helper will be exported by the implementation):

```typescript
import { toAnthropicSystem } from '../../src/providers/anthropic';

describe('toAnthropicSystem', () => {
  it('returns a single system block when no front block is given', () => {
    expect(toAnthropicSystem('SYS', undefined)).toEqual([
      { type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('appends the paper full text as a second cached block', () => {
    const blocks = toAnthropicSystem('SYS', 'PAPER BODY');
    expect(blocks).toEqual([
      { type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } },
      {
        type: 'text',
        text: '[Paper full text]\nPAPER BODY',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/anthropic.test.ts`
Expected: FAIL — `toAnthropicSystem` is not exported.

- [ ] **Step 3: Implement `toAnthropicSystem` and use it in `stream`**

In `src/providers/anthropic.ts`, add this exported function near `toAnthropicMessages`:

```typescript
// Builds the Anthropic `system` array. The system prompt is block 1
// (ephemeral cache). When a front block (paper full text) is present it
// becomes block 2 with its own 1h-TTL cache breakpoint — the feature exists
// to survive the user's reading time between turns.
export function toAnthropicSystem(
  systemPrompt: string,
  pinnedFullText: string | undefined,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
  ];
  if (pinnedFullText) {
    blocks.push({
      type: 'text',
      text: `[Paper full text]\n${pinnedFullText}`,
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
  }
  return blocks;
}
```

In the `stream` method, rename the unused `_options` parameter to `options` and use it. Change the signature line and the `baseRequest.system`:

```typescript
  async *stream(
    messages: Message[],
    systemPrompt: string,
    preset: ModelPreset,
    signal: AbortSignal,
    options: ProviderStreamOptions = {},
  ): AsyncIterable<StreamChunk> {
```

```typescript
    const baseRequest = {
      model: preset.model,
      max_tokens: preset.maxTokens,
      system: toAnthropicSystem(systemPrompt, options.pinnedFullText),
      messages: toAnthropicMessages(messages),
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/providers/anthropic.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/providers/anthropic.ts tests/providers/anthropic.test.ts
git commit -m "feat: render pinned full text as a cached Anthropic system block"
```

---

## Task 4: OpenAI front block in both tool loops

**Files:**
- Modify: `src/providers/openai.ts` — `streamWithTools` (301-479), `streamChatCompletions` (181-299)
- Test: `tests/providers/openai.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/providers/openai.test.ts` (a `withFrontBlock` helper will be exported by the implementation):

```typescript
import { withFrontBlock } from '../../src/providers/openai';

describe('withFrontBlock', () => {
  it('returns the list unchanged when no front block is given', () => {
    const items = [{ role: 'user', content: 'hi' }];
    expect(withFrontBlock(items, undefined)).toBe(items);
  });

  it('prepends the front block at index 0 for the Responses input', () => {
    const items = [{ role: 'user', content: 'hi' }];
    expect(withFrontBlock(items, 'PAPER')).toEqual([
      { role: 'user', content: '[Paper full text]\nPAPER' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('inserts the front block after a leading system message', () => {
    const items = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hi' },
    ];
    expect(withFrontBlock(items, 'PAPER')).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: '[Paper full text]\nPAPER' },
      { role: 'user', content: 'hi' },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/openai.test.ts`
Expected: FAIL — `withFrontBlock` is not exported.

- [ ] **Step 3: Implement the `withFrontBlock` helper**

In `src/providers/openai.ts`, add near `toOpenAIInput`:

```typescript
// Prepends the paper full text as a front block immediately after the system
// prompt and before conversation history. Used by both OpenAI tool loops.
// Returns the SAME array reference when no front block is set (no behavior
// change). The Responses `input` has no leading system item (the system
// prompt is the separate `instructions` field), so for it the block goes at
// index 0; Chat Completions keeps the system message at index 0, so the block
// goes at index 1.
export function withFrontBlock<T extends { role?: string }>(
  items: T[],
  frontBlock: string | undefined,
): T[] {
  if (!frontBlock) return items;
  const block = {
    role: 'user',
    content: `[Paper full text]\n${frontBlock}`,
  } as unknown as T;
  if (items[0]?.role === 'system') {
    return [items[0], block, ...items.slice(1)];
  }
  return [block, ...items];
}
```

- [ ] **Step 4: Use the front block in `streamWithTools`**

In `streamWithTools`, after `const input: unknown[] = toOpenAIInput(messages);` (line 318), add:

```typescript
    let frontBlock: string | undefined = options.pinnedFullText;
```

Change the request `input` field (line 329) from `input,` to:

```typescript
            input: withFrontBlock(input as Array<{ role?: string }>, frontBlock),
```

In the tool-execution loop, after `const result = await executeToolCall(...)` (line 451-456) and before the `yield { type: 'tool_call', ... status: result.status ... }`, add:

```typescript
        if (result.result.frontBlock) frontBlock = result.result.frontBlock;
```

- [ ] **Step 5: Use the front block in `streamChatCompletions`**

In `streamChatCompletions`, after `const chatMessages: ChatMessage[] = toChatMessages(messages, systemPrompt);` (line 195), add:

```typescript
    let frontBlock: string | undefined = options.pinnedFullText;
```

Change the request `messages` field (line 203) from `messages: chatMessages,` to:

```typescript
            messages: withFrontBlock(
              chatMessages as Array<{ role?: string }>,
              frontBlock,
            ) as ChatMessage[],
```

In the tool-execution loop, after `const result = await executeToolCall(...)` (line 292) and before the following `yield`, add:

```typescript
        if (result.result.frontBlock) frontBlock = result.result.frontBlock;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/providers/openai.test.ts`
Expected: PASS.

- [ ] **Step 7: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/providers/openai.ts tests/providers/openai.test.ts
git commit -m "feat: prepend pinned full text as a front block in OpenAI tool loops"
```

---

## Task 5: zotero_get_full_pdf feeds the front block

**Files:**
- Modify: `src/context/agent-tools.ts:228-263`
- Test: `tests/context/agent-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/context/agent-tools.test.ts` a test that calls the `zotero_get_full_pdf` tool and asserts the new shape. Match the existing test setup in that file for building a tool session; the assertions are:

```typescript
it('zotero_get_full_pdf returns a front block and an ack, not the buried text', async () => {
  // Build a tool session over a source whose getFullText returns 'PAPER BODY'
  // (follow the existing agent-tools.test.ts harness for session setup).
  const tool = tools.find((t) => t.name === 'zotero_get_full_pdf')!;
  const result = await tool.execute({});

  // The full text is delivered via frontBlock, NOT the tool output.
  expect(result.frontBlock).toBe('PAPER BODY');
  expect(result.output).not.toContain('PAPER BODY');
  expect(result.output).toContain('[Paper full text]');
  expect(result.context?.planMode).toBe('full_pdf');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/context/agent-tools.test.ts`
Expected: FAIL — `result.frontBlock` is `undefined` and `result.output` still contains the body.

- [ ] **Step 3: Rewrite the `zotero_get_full_pdf` execute handler**

In `src/context/agent-tools.ts`, add an import at the top:

```typescript
import { freezeFullText, getFrozenFullText } from '../settings/paper-cache';
```

Replace the `execute` handler of `zotero_get_full_pdf` (lines 232-263) with:

```typescript
      execute: async () => {
        const itemID = currentItemID(options);
        if (itemID == null)
          return errorResult('No Zotero item is currently selected.');
        // Reuse a frozen copy if one exists (cache-existence check); only
        // extract when there is no usable cache.
        let text = await getFrozenFullText(itemID);
        let truncated = false;
        let totalChars = 0;
        if (text == null) {
          const pdfText = await getToolPdfText(options, itemID);
          if (!pdfText) return errorResult(readablePdfTextError());
          text = truncateByTokenBudget(pdfText, policy.fullPdfTokenBudget);
          truncated = text.length < pdfText.length;
          totalChars = pdfText.length;
          await freezeFullText(itemID, text, 'full_pdf');
        } else {
          totalChars = text.length;
        }
        const sourceContext = await zoteroSourceContext(options, itemID);
        return {
          output: [
            'Full paper text is now provided at the start of this',
            'conversation under the heading [Paper full text]. Read the paper',
            'from there. Do not call zotero_get_full_pdf again this turn.',
          ].join(' '),
          summary: `读取 PDF 全文 ${text.length}/${totalChars} 字`,
          frontBlock: text,
          context: {
            planMode: 'full_pdf',
            ...sourceContext,
            fullTextChars: text.length,
            fullTextTotalChars: totalChars,
            fullTextTruncated: truncated,
            rangeStart: 0,
            rangeEnd: text.length,
          },
        };
      },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/context/agent-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/context/agent-tools.ts tests/context/agent-tools.test.ts
git commit -m "feat: zotero_get_full_pdf feeds the front block instead of a buried result"
```

---

## Task 6: Orchestrator passes pinnedFullText

**Files:**
- Modify: `src/modules/sidebar.ts` — the `getProvider(preset).stream(...)` call (around line 4199-4211) and the surrounding `try` block (around line 4108-4140)

- [ ] **Step 1: Add a helper that resolves the pinned full text**

In `src/modules/sidebar.ts`, add an import:

```typescript
import { freezeFullText, getFrozenFullText, isPaperPinned } from "../settings/paper-cache";
```

Add a helper function near the orchestrator (module scope):

```typescript
// When the "原文" toggle is on for this item, resolve the frozen full text to
// pin as the provider front block. If pinned but nothing is frozen yet (user
// toggled on before any fetch), extract once and freeze. Returns undefined
// when not pinned or when no PDF text is available.
async function resolvePinnedFullText(
  itemID: number | null,
  source: ZoteroContextSource,
  policy: ContextPolicy,
): Promise<string | undefined> {
  if (itemID == null) return undefined;
  if (!(await isPaperPinned(itemID))) return undefined;
  const frozen = await getFrozenFullText(itemID);
  if (frozen != null) return frozen;
  const pdfText = await source.getFullText(itemID);
  if (!pdfText) return undefined;
  const text = truncateByTokenBudget(pdfText, policy.fullPdfTokenBudget);
  await freezeFullText(itemID, text, "full_pdf");
  return text;
}
```

Note: confirm the exact symbol names `ZoteroContextSource`, `truncateByTokenBudget`, and `source.getFullText` against `src/context/zotero-source.ts` and `src/context/agent-tools.ts` while implementing; reuse the same `source` object the tool session is built from (`zoteroContextSource` at `sidebar.ts:4148`). If `truncateByTokenBudget` is not exported, export it from `src/context/agent-tools.ts`.

- [ ] **Step 2: Resolve the pinned text before the stream call**

In the orchestrator `try` block, after `const baseContext = await buildSystemContextOnly(state.itemID);` (line 4140), add:

```typescript
    const pinnedFullText = await resolvePinnedFullText(
      state.itemID,
      zoteroContextSource,
      contextPolicy,
    );
```

- [ ] **Step 3: Pass `pinnedFullText` into the provider**

In the `getProvider(preset).stream(...)` options object (lines 4204-4210), add the field:

```typescript
      {
        tools: toolSession.tools,
        maxToolIterations: contextPolicy.maxToolIterations,
        permissionMode: state.agentPermissionMode,
        toolSettings: loadToolSettings(zoteroPrefs()),
        promptCacheKey: buildPromptCacheKey(preset, state.itemID),
        ...(pinnedFullText ? { pinnedFullText } : {}),
      },
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add src/modules/sidebar.ts src/context/agent-tools.ts
git commit -m "feat: pass pinned paper full text into the provider stream"
```

---

## Task 7: The "原文" toggle button

**Files:**
- Modify: `src/modules/sidebar.ts` — `PanelState` type; the panel-render path that loads per-item state; the `renderWebSearchSwitcher` call site; new `renderPaperPinSwitcher`

- [ ] **Step 1: Add `paperPinned` to `PanelState`**

In `src/modules/sidebar.ts`, in the `PanelState` interface (starts at line 333), add an OPTIONAL field — optional so no constructor site needs touching; an `undefined` value reads as "off":

```typescript
  // Mirrors the per-item "原文" toggle (paper-cache `pinned`). Loaded async by
  // loadPersistedMessages; the toggle button renders from it synchronously.
  paperPinned?: boolean;
```

- [ ] **Step 2: Load `paperPinned` in `loadPersistedMessages`**

In `loadPersistedMessages` (`src/modules/sidebar.ts:4624`), after
`const messages = await loadChatMessages(state.itemID);` (line 4626), add:

```typescript
  const paperPinned =
    state.itemID != null ? await isPaperPinned(state.itemID) : false;
```

Then, just after `state.historyLoaded = true;` (line 4638), add:

```typescript
  state.paperPinned = paperPinned;
```

The existing `renderPanel(mount, state)` at the end of the function (line 4643)
already re-renders.

- [ ] **Step 3: Implement `renderPaperPinSwitcher`**

In `src/modules/sidebar.ts`, add (modeled on `renderWebSearchSwitcher` at line 3280, but a plain toggle — no popup):

```typescript
function renderPaperPinSwitcher(
  doc: Document,
  mount: HTMLElement,
  state: PanelState,
): HTMLElement {
  const wrap = el(doc, "div", "web-search-switcher");
  const trigger = doc.createElement("button");
  trigger.type = "button";
  trigger.className = "web-search-trigger";
  const hasItem = state.itemID != null;
  const on = state.paperPinned === true;
  trigger.textContent = on ? "📄 原文" : "＋ 原文";
  trigger.title = !hasItem
    ? "请先在 Zotero 中选择一篇有 PDF 的论文"
    : on
      ? "原文固定已开启：每轮把论文全文钉在对话最前面，模型始终基于完整原文回答；全文已缓存以降低重复发送成本。点击关闭。"
      : "点击开启：把论文全文固定在每轮对话最前面，避免回答退化成“摘要的摘要”，并让全文可被缓存复用。";
  trigger.disabled = !hasItem || state.sending;
  trigger.addEventListener("click", () => {
    if (state.itemID == null) return;
    const next = !state.paperPinned;
    state.paperPinned = next;
    void setPaperPinned(state.itemID, next);
    renderPanel(mount, state);
  });
  wrap.append(trigger);
  return wrap;
}
```

Add the import:

```typescript
import { isPaperPinned, setPaperPinned } from "../settings/paper-cache";
```

(If Task 6 already added a `paper-cache` import line, extend it instead of adding a second.)

- [ ] **Step 4: Render the toggle next to the web-search switcher**

In `src/modules/sidebar.ts:3065`, change:

```typescript
  row.append(inputStack, renderWebSearchSwitcher(doc, mount, state));
```

to:

```typescript
  row.append(
    inputStack,
    renderWebSearchSwitcher(doc, mount, state),
    renderPaperPinSwitcher(doc, mount, state),
  );
```

- [ ] **Step 5: Manual verification**

Build and install the XPI, restart Zotero:

```bash
npm run build
cp .scaffold/build/zotero-ai-sidebar.xpi /home/qwer/.zotero/zotero/24q8duho.default/extensions/zotero-ai-sidebar@local.xpi
```

Verify in Zotero: the `＋ 原文` button shows next to `联网`; clicking toggles it to `📄 原文`; the state survives closing/reopening the item and restarting Zotero; hovering shows the tooltip. With the toggle on, ask a paper question and confirm via the context trace that the full text is sent.

- [ ] **Step 6: Commit**

```bash
git add src/modules/sidebar.ts
git commit -m "feat: add the 原文 paper-pin toggle to the composer"
```

---

## Task 8: Toggle button styling

**Files:**
- Modify: `addon/content/sidebar.css`

- [ ] **Step 1: Confirm shared styling**

`renderPaperPinSwitcher` reuses the `web-search-switcher` / `web-search-trigger` class names, so it already inherits the existing rules at `sidebar.css:1791-1838`. Verify in the browser (Task 7 Step 5) that the button matches the "联网" button visually.

- [ ] **Step 2: Add an "on" accent (only if the on-state is not visually distinct)**

If the `📄 原文` on-state is not visually distinguishable from off, add a minimal rule near the web-search block in `addon/content/sidebar.css`. Give the on-state wrapper a class in `renderPaperPinSwitcher` (`web-search-switcher web-search-live` when `on`) so it reuses the existing `.web-search-live .web-search-trigger` accent at `sidebar.css:1819` — no new CSS needed. Apply this by changing the `wrap` line in `renderPaperPinSwitcher`:

```typescript
  const wrap = el(
    doc,
    "div",
    on ? "web-search-switcher web-search-live" : "web-search-switcher",
  );
```

- [ ] **Step 3: Commit (only if a code change was made)**

```bash
git add src/modules/sidebar.ts
git commit -m "style: give the 原文 toggle an on-state accent"
```

---

## Final Verification

- [ ] Run `npm test` — all suites pass.
- [ ] Run `npm run build` — builds clean.
- [ ] Manual: with the toggle OFF, default behavior is unchanged (model decides; `zotero_get_full_pdf` still works — now via the front block + ack).
- [ ] Manual: with the toggle ON, the paper full text is present at the front every turn; the state persists per item across restarts.
