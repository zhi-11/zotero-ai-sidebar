export interface ComposerDraftState {
  draftText: string;
  draftSelectionStart: number;
  draftSelectionEnd: number;
  draftHadFocus: boolean;
}

export function captureDraftFromInput<TState extends ComposerDraftState>(
  input: HTMLTextAreaElement,
  state: TState,
  captureFocus = true,
) {
  state.draftText = input.value;
  state.draftSelectionStart = clampOffset(
    input.selectionStart ?? input.value.length,
    input.value,
  );
  state.draftSelectionEnd = clampOffset(
    input.selectionEnd ?? state.draftSelectionStart,
    input.value,
  );
  if (captureFocus) {
    state.draftHadFocus = input.ownerDocument?.activeElement === input;
  }
}

export function clampOffset(offset: number, text: string): number {
  return Math.max(0, Math.min(offset, text.length));
}
