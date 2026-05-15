# Manual Paper Pin — Design Spec

- Date: 2026-05-16
- Status: approved for implementation planning

## Context & Motivation

The plugin's context ledger ("strip") design never replays past full-PDF text;
the model must re-fetch the paper when it needs it. Two observed problems:

1. **Summary degradation.** When the user asks a paper-scope follow-up, the
   model often does NOT re-fetch the paper — it satisfices on its own earlier
   summary sitting in history. The result is a "summary of a summary": fidelity
   to the source decays each turn. Even an explicit "请再阅读原文" in the user
   message does not reliably force a re-fetch, because tool choice is
   model-driven and the model reuses whatever cheap path is available.

2. **No cross-turn cache for paper content.** Prompt caching is a contiguous
   prefix match from token 0. In the current structure the full text sits
   *after* the growing conversation history, so its prefix position shifts
   every turn — it can never hit cache cross-turn, regardless of which turns
   carry it.

This feature adds an **opt-in manual override**: a per-item toggle that pins
the paper full text at a stable position so the model always has the real
paper, and so the text becomes cache-eligible cross-turn.

## Goals

- Give the user an explicit, reliable way to keep the full paper in context.
- Place the pinned full text where it can hit prompt cache cross-turn.
- Freeze the extracted full text to a file so every turn sends byte-identical
  content (a hard requirement for prompt-cache hits).
- Leave the default behavior (strip / model-driven) completely unchanged.

## Non-Goals

- Fixing the relay's multi-account cache routing (erratic hit rate). That is a
  relay-config concern, outside the plugin.
- Auto-detecting when to pin (no semantic intent matching — CLAUDE.md red line).
- Re-capturing / refreshing a frozen full text after the PDF changes (YAGNI).
- Relaxing the `prompt_cache_key` gate for relay endpoints (related but separate;
  may be requested independently).

## Decisions (locked with user)

| Decision | Choice |
|---|---|
| Default behavior | Unchanged: no full text, model decides |
| Control type | Persistent toggle (not one-shot) |
| Toggle persistence | Per-item, remembered across restarts |
| Positioning approach | B — pinned block via `toApiMessages`, provider-agnostic |
| Byte-stability mechanism | Extract once, freeze to a file, re-read every turn |

## Design

### 1. UI control — "原文" persistent toggle

- Location: composer footer left (`composer-footer-left`), next to the
  existing "联网" `web-search-switcher`.
- Reuses the web-search trigger styling, morphed by state: OFF shows
  `＋ 原文`, ON shows `📄 原文`. (Morph an existing-style control; no new
  floating/conditional button.)
- Hover tooltip, ON/OFF variants, explaining *why*: when on, the paper full
  text is fixed at the front of every turn so the model always answers from
  the complete source (no "summary of a summary"), and the text is cached to
  cut repeated-send cost.
- Disabled when the current item has no extractable PDF full text; tooltip
  explains the reason (mirrors how "联网" is disabled for non-OpenAI configs).
- Reflects the per-item `pinned` state from the cache file.

### 2. Full-text capture & cache file

- New standalone file: `~/Zotero/zotero-ai-sidebar-paper-cache.json`, in the
  same directory as `zotero-ai-sidebar-chat-history.json` (reuse `historyDir()`).
- Keyed by `item:<itemID>`. Each entry:
  `{ pinned: boolean, fullText: string, charCount: number, capturedAt: string, source: 'full_pdf' }`.
- On first toggle-ON for an item: extract full text via the existing
  full-text path (same source as `zotero_get_full_pdf`), then **freeze** that
  exact string into the file.
- Every subsequent turn: read the frozen string from the file. Never
  re-extract while a frozen copy exists — this guarantees byte-identical
  content turn to turn (required for prompt-cache hits).
- Writes serialized via a `writeQueue` (mirror `chat-history.ts`).
- Reads use a normalize-on-read / discard-malformed pattern (mirror
  `chat-history.ts`).
- The `pinned` toggle state is stored in this same file — this is how the
  toggle is "remembered per item".
- Toggling OFF sets `pinned: false` but keeps the frozen `fullText`; toggling
  ON again reuses the frozen copy with no re-extraction.

### 3. Pinned positioning (Approach B)

- `toApiMessages` gains a parameter `pinnedFullText?: string`.
- The sidebar orchestrator (around `sidebar.ts:4109`) reads the cache file for
  the current item; if `pinned` is true, it passes the frozen string in.
- When pinned: a `[Pinned paper full text]\n<frozen string>` block is
  prepended to the **content of the first user message** in the wire output.
  This places it directly after `[system]` and before all conversation
  history. It is a real user message (no provider role-alternation issue) and
  byte-stable (frozen text + the first message's fixed content).
- The pinned block does NOT participate in strip logic: when pinned it is
  always present; when not pinned it never appears and the existing
  strip / model-driven behavior is untouched.

### 4. Provider caching markers

- Anthropic: add a `cache_control` breakpoint on the first user message's
  content block when pinned, using the extended **1h TTL** variant (the
  feature's purpose is to survive the user's reading time between turns).
- OpenAI: automatic prefix caching — no markers needed; a stable front
  position is sufficient.

### 5. Interaction with `zotero_get_full_pdf`

- When pinned, the full text is already in context. If the model still calls
  `zotero_get_full_pdf`, the tool returns a structured note: full paper text
  is already pinned at the start of the conversation as
  `[Pinned paper full text]`, no need to fetch again. It does NOT return the
  duplicate ~44k payload.
- The tool is not removed (harness stays model-driven); it becomes
  pinned-aware.
- `zotero_get_reader_pdf_text` (Reader text layer, used for highlight
  coordinates) is unaffected — it is a different source and highlighting still
  needs it.

### 6. Edge cases & error handling

- Item has no PDF / extraction fails: toggle disabled, or toggle-on fails with
  a visible error.
- Oversized paper: apply the existing `policy.fullPdfTokenBudget` (60k tokens)
  cap; truncate and mark truncation, consistent with current `full_pdf`
  behavior.
- Corrupt cache file: normalize-on-read discards malformed entries rather than
  failing the load.
- Frozen text is captured once; "re-capture" is out of scope.

### 7. Testing

- `toApiMessages` pinned-block insertion (pinned on/off, first-message
  targeting) — `tests/context/message-format.test.ts`.
- Cache file read/write/corruption-tolerance — new test mirroring
  `chat-history` tests.
- `npm test` passes.

## Files Affected

- `src/modules/sidebar.ts` — toggle button UI; orchestrator reads cache file
  and passes `pinnedFullText`.
- `src/settings/paper-cache.ts` — NEW: the paper cache file (read/write/freeze).
- `src/context/message-format.ts` — `toApiMessages` pinned-block prepend.
- `src/providers/anthropic.ts` — `cache_control` on the pinned block (1h TTL).
- `src/context/agent-tools.ts` — `zotero_get_full_pdf` pinned-aware response.
- `addon/content/sidebar.css` — toggle button styling.
- `addon/locale/` — toggle label and tooltip strings.
