export interface PasteBlock {
  id: number;
  marker: string;
  text: string;
  lineCount: number;
}

export interface PasteState {
  pasteBlocks: PasteBlock[];
  nextPasteID: number;
}

// Paste compaction
// =====================================================================
// Long pastes are stored OUT-OF-BAND in `state.pasteBlocks` and replaced
// in the textarea with a short marker like `[Pasted #1 +42 lines]`. The
// marker preserves: (a) sidebar UI doesn't fight 1000-line paste with
// scroll; (b) the textarea remains snappy for editing the prompt around
// the paste. `expandPasteMarkers` rejoins the real content at SEND TIME
// so the user can move/delete the marker without re-pasting.
//
// Threshold tuned by feel: 5 lines or 900 chars. Smaller pastes inline.
export function shouldCompactPastedText(text: string): boolean {
  return countLines(text) > 5 || text.length > 900;
}

export function insertPastedTextMarker<TState extends PasteState>(
  input: HTMLTextAreaElement,
  state: TState,
  text: string,
) {
  const id = state.nextPasteID++;
  const lineCount = countLines(text);
  const marker = `[Pasted text #${id} +${lineCount} lines]`;
  state.pasteBlocks.push({ id, marker, text, lineCount });

  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  const prefix = before && !before.endsWith("\n") ? "\n" : "";
  const suffix = after && !after.startsWith("\n") ? "\n" : "";
  input.value = `${before}${prefix}${marker}${suffix}${after}`;
  const cursor = before.length + prefix.length + marker.length;
  input.selectionStart = cursor;
  input.selectionEnd = cursor;
}

export function expandPasteMarkers<TState extends PasteState>(
  text: string,
  state: TState,
): string {
  let expanded = text;
  for (const block of state.pasteBlocks) {
    expanded = expanded.replace(
      block.marker,
      `${block.marker}\n\n${block.text}`,
    );
  }
  return expanded;
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split(/\r\n|\r|\n/).length;
}

export function selectedLineCount(text: string): number {
  if (!text) return 0;
  const byBreak = countLines(text);
  if (byBreak > 1) return byBreak;
  return Math.max(1, Math.ceil(text.length / 90));
}
