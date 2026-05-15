# Front-Positioned Paper Full Text — Design Spec

- Date: 2026-05-16
- Status: approved design; spec expanded after scope clarification — awaiting re-review

## Context & Motivation

The plugin's context ledger ("strip") design never replays past full-PDF text.
Two observed problems:

1. **Summary degradation.** On a paper-scope follow-up the model often does not
   re-fetch the paper — it satisfices on its own earlier summary in history.
   The result is a "summary of a summary": fidelity decays each turn. Even an
   explicit "请再阅读原文" does not reliably force a re-fetch.

2. **No cross-turn cache for paper content.** Prompt caching is a contiguous
   prefix match from token 0. Today the full text is delivered as a tool
   result (`function_call_output`) bound to its tool call mid-conversation, or
   inlined late in a user message — its prefix position shifts every turn, so
   it never hits cache cross-turn.

The fix the user asked for is narrow and specific: **change where the full
text sits in the request.** Whenever the full text enters the prompt — by the
new manual toggle OR by the model's own `zotero_get_full_pdf` fetch — it should
sit at one canonical position (immediately after the system prompt, before all
conversation history), the "Codex-style" stable-prefix position.

## Goals

- One canonical position for the paper full text: immediately after the system
  prompt, before conversation history. Applies to every path that sends it.
- Byte-stable full text: extract once, freeze to a file, re-read every turn so
  repeated sends are byte-identical (a hard precondition for cache hits).
- A manual per-item toggle to pin the paper persistently.
- The model's default `zotero_get_full_pdf` fetch is repositioned to the same
  canonical spot (turn-scoped, not persisted).
- Change ONLY full-text positioning. Every other behavior — model-driven tool
  decisions, search / range / annotation tools, the strip ledger for
  non-full-text context — is untouched.

## Non-Goals

- Fixing the relay's multi-account cache routing (erratic hit rate). Relay-side.
- Auto-detecting when to pin (no semantic intent matching — CLAUDE.md red line).
- Re-capturing a frozen full text after the PDF changes (YAGNI).
- Repositioning on the Anthropic chat path's *default fetch*: the Anthropic
  adapter has no agent tool loop (`anthropic.ts:13`), so the model cannot call
  `zotero_get_full_pdf` there at all. The manual toggle still works on Anthropic.

## Decisions (locked with user)

| Decision | Choice |
|---|---|
| Default behavior when nothing sends the paper | Unchanged: model decides |
| Manual control type | Persistent toggle (not one-shot) |
| Toggle persistence | Per-item, remembered across restarts |
| Full-text canonical position | Immediately after system prompt, before history |
| Byte-stability mechanism | Extract once, freeze to a file, re-read every turn |
| Model's default `zotero_get_full_pdf` fetch | Repositioned to the canonical spot, turn-scoped, NOT persisted |

**Implementation constraint (per user):** the only behavioral change is full-text
positioning. The OpenAI tool loop gains a turn-scoped "front block" slot; it is
purely additive — when no front block is set the loop behaves exactly as today.
Everything else is new, additive code (toggle UI, cache-file module).

## Design

### 1. Core mechanism — the front full-text block

A single concept: a **front full-text block** — `[Paper full text]\n<frozen
text>` placed immediately after the system prompt, before all conversation
history. It is byte-stable because its text always comes from the frozen cache
file (Section 3). Two independent triggers feed this one block:

- Trigger A — the manual toggle (Section 4): persistent, every turn.
- Trigger B — the model's `zotero_get_full_pdf` fetch (Section 5): turn-scoped.

Because both triggers place the identical frozen text at the identical
position, sends from either path are mutually cache-consistent.

### 2. UI control — "原文" persistent toggle

- Location: composer footer left (`composer-footer-left`), next to the
  existing "联网" `web-search-switcher` (`sidebar.ts:3280`).
- Reuses the web-search trigger styling, morphed by state: OFF shows
  `＋ 原文`, ON shows `📄 原文`. No new floating/conditional button.
- Hover tooltip, ON/OFF variants, explaining *why*: when on, the paper full
  text is fixed at the front of every turn so the model always answers from
  the complete source, and the text is cached to cut repeated-send cost.
- Disabled when the current item has no extractable PDF full text; tooltip
  explains the reason (mirrors how "联网" is disabled for non-OpenAI configs).
- Reflects the per-item `pinned` state from the cache file.

### 3. Cache file — frozen full text

- New standalone file: `~/Zotero/zotero-ai-sidebar-paper-cache.json`, in the
  same directory as `zotero-ai-sidebar-chat-history.json` (reuse `historyDir()`
  from `chat-history.ts`).
- Keyed by `item:<itemID>`. Each entry:
  `{ pinned: boolean, fullText: string, charCount: number, capturedAt: string, source: 'full_pdf' }`.
- First capture (by EITHER trigger): extract full text via the existing
  full-text path (same source as `zotero_get_full_pdf`), apply the
  `policy.fullPdfTokenBudget` cap, then freeze the resulting string into the
  file.
- Every later read (either trigger): read the frozen string. Never re-extract
  while a frozen copy exists — guarantees byte-identical content turn to turn.
- `pinned` is set true/false ONLY by the toggle. Trigger B reads/writes
  `fullText` but never changes `pinned`.
- Toggling OFF sets `pinned: false` but keeps the frozen `fullText`.
- Writes serialized via a `writeQueue`; reads use normalize-on-read /
  discard-malformed — both mirror `chat-history.ts`.

### 4. Trigger A — manual toggle (persistent)

- When `pinned` is true for the current item, the sidebar orchestrator
  (`sidebar.ts`, around line 4199) passes the frozen full text into the
  provider via a new `ProviderStreamOptions.pinnedFullText` field.
- The provider sets this as the initial front block (Section 6).
- Present on every turn until the user toggles off.

### 5. Trigger B — model's `zotero_get_full_pdf` fetch (turn-scoped)

- `zotero_get_full_pdf` (`agent-tools.ts:228`) is changed so it no longer
  returns the full text as a buried tool result. Instead, on execute it:
  1. ensures the full text is captured to the cache file (extract + freeze if
     no frozen copy exists; otherwise reuse the frozen copy);
  2. sets the provider's turn-scoped front block to the frozen text;
  3. returns a SHORT acknowledgement as the tool result, e.g. "Full paper text
     is now provided at the start of the conversation as [Paper full text];
     read it there." plus the existing `context` metadata.
- The model, on the next loop iteration, sees the front block and answers.
- Turn-scoped: this does NOT set `pinned`. Next turn, if the model does not
  call the tool again and the toggle is off, no front block is rendered — the
  existing strip behavior is preserved.
- Because the front block always holds the same frozen text at the same
  position, a re-fetch in a later turn is byte/position-identical to an
  earlier fetch — cross-turn cache-eligible.
- This path applies on the OpenAI provider only; the Anthropic adapter has no
  agent tool loop, so the model cannot call this tool there.

### 6. Provider front-block slot

- The provider gains a turn-scoped front-block slot. It can be set two ways,
  both feeding the same slot:
  - initially, via `ProviderStreamOptions.pinnedFullText` (Trigger A);
  - mid-loop, by the `zotero_get_full_pdf` tool (Trigger B) through a callback
    exposed on the tool session.
- On every model request the provider prepends the current front block,
  immediately after the system prompt and before all conversation messages.
- OpenAI: render the front block as the first item of the `input` array
  (a user-role message holding `[Paper full text]\n<text>`).
- Anthropic: render it as a second `system` content block (Anthropic supports
  multi-block `system`); Trigger B is N/A on Anthropic (no tool loop).
- When the front block is unset, the provider behaves exactly as today
  (additive — no behavior change).

### 7. Provider caching markers

- Anthropic: give the front-block `system` content block its own
  `cache_control` breakpoint, using the extended **1h TTL** variant (the
  feature exists to survive the user's reading time between turns).
- OpenAI: automatic prefix caching — a stable front position is sufficient,
  no markers needed.

### 8. Edge cases & error handling

- Item has no PDF / extraction fails: toggle disabled, or toggle-on fails with
  a visible error; `zotero_get_full_pdf` returns its existing error result.
- Oversized paper: apply `policy.fullPdfTokenBudget` (60k tokens) at capture
  time; truncate and mark truncation — consistent with current behavior.
- Corrupt cache file: normalize-on-read discards malformed entries.
- Frozen text is captured once; "re-capture" is out of scope.

### 9. Testing

- Provider front-block slot: front block rendered after system / before
  history; absent when unset (no behavior change) — provider tests.
- `zotero_get_full_pdf` returns the ack + sets the front block — `agent-tools`
  tests.
- Cache file read/write/corruption-tolerance — new test mirroring
  `chat-history` tests.
- `npm test` passes.

## Files Affected

- `src/settings/paper-cache.ts` — NEW: cache file (read / write / freeze).
- `src/providers/types.ts` — `ProviderStreamOptions.pinnedFullText`; tool-session
  callback type for the mid-loop front block.
- `src/providers/openai.ts` — front-block slot in the tool loop; render as the
  first `input` item; accept the mid-loop callback.
- `src/providers/anthropic.ts` — render the front block as a second `system`
  block with `cache_control` (1h TTL).
- `src/context/agent-tools.ts` — `zotero_get_full_pdf` sets the front block and
  returns an ack instead of the buried full text.
- `src/modules/sidebar.ts` — "原文" toggle button; orchestrator reads the cache
  file and passes `pinnedFullText`.
- `addon/content/sidebar.css` — toggle button styling.
- `addon/locale/` — toggle label and tooltip strings.
