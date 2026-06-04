import type { PrefsStore } from '../settings/storage';
import {
  DEFAULT_TRANSLATE_SETTINGS,
  DEFAULT_ANNOTATION_COLORS,
  type AnnotationColorPreset,
  type TranslateSettings,
  type TranslateThinking,
  type TranslateContextLevel,
  type TranslateTriggerMode,
  type TranslateOverlaySize,
  type TranslateOverlayPosition,
  DEFAULT_SENTENCE_EXCEPTIONS,
} from '../settings/types';

const KEY = 'extensions.zotero-sentence-translator.translateSettings';

export function loadTranslateSettings(prefs: PrefsStore): TranslateSettings {
  const raw = prefs.get(KEY);
  if (!raw) return { ...DEFAULT_TRANSLATE_SETTINGS };
  try {
    return normalizeTranslateSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_TRANSLATE_SETTINGS };
  }
}

export function saveTranslateSettings(prefs: PrefsStore, settings: TranslateSettings): void {
  prefs.set(KEY, JSON.stringify(normalizeTranslateSettings(settings)));
}

export function normalizeTranslateSettings(value: unknown): TranslateSettings {
  const input = (value && typeof value === 'object' ? value : {}) as Partial<TranslateSettings>;
  return {
    enabled: input.enabled === true,
    presetId: typeof input.presetId === 'string' ? input.presetId : '',
    model: typeof input.model === 'string' ? input.model : '',
    thinking: pickThinking(input.thinking),
    ctxLevel: pickCtxLevel(input.ctxLevel),
    overlayPosition: pickPosition(input.overlayPosition),
    overlaySize: pickOverlaySize(input.overlaySize),
    triggerMode: pickTriggerMode(input.triggerMode),
    prevSentenceKey: typeof input.prevSentenceKey === 'string' && input.prevSentenceKey
      ? input.prevSentenceKey : DEFAULT_TRANSLATE_SETTINGS.prevSentenceKey,
    nextSentenceKey: typeof input.nextSentenceKey === 'string' && input.nextSentenceKey
      ? input.nextSentenceKey : DEFAULT_TRANSLATE_SETTINGS.nextSentenceKey,
    annotationColors: normalizeAnnotationColors(input.annotationColors),
    saveTranslationComment: input.saveTranslationComment !== false,
    sentenceExceptions: normalizeSentenceExceptions(input.sentenceExceptions),
    translateToggleShortcut: typeof input.translateToggleShortcut === "string"
      ? input.translateToggleShortcut
      : DEFAULT_TRANSLATE_SETTINGS.translateToggleShortcut,
    overlayFontSize: typeof input.overlayFontSize === "number"
      && input.overlayFontSize >= 10 && input.overlayFontSize <= 28
      ? input.overlayFontSize
      : DEFAULT_TRANSLATE_SETTINGS.overlayFontSize,
  };
}

export function normalizeAnnotationColors(value: unknown): AnnotationColorPreset[] {
  if (!Array.isArray(value)) return [...DEFAULT_ANNOTATION_COLORS];
  const out: AnnotationColorPreset[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const parsed = parseAnnotationColor(entry);
    if (!parsed || seen.has(`${parsed.label}\n${parsed.color}`)) continue;
    seen.add(`${parsed.label}\n${parsed.color}`);
    out.push(parsed);
  }
  return out.length ? out : [...DEFAULT_ANNOTATION_COLORS];
}

function parseAnnotationColor(entry: unknown): AnnotationColorPreset | null {
  if (Array.isArray(entry)) {
    const label = typeof entry[0] === 'string' ? entry[0].trim() : '';
    const color = typeof entry[1] === 'string' ? entry[1].trim() : '';
    return label && isHexColor(color) ? { label, color } : null;
  }
  if (entry && typeof entry === 'object') {
    const raw = entry as Partial<AnnotationColorPreset>;
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    const color = typeof raw.color === 'string' ? raw.color.trim() : '';
    return label && isHexColor(color) ? { label, color } : null;
  }
  return null;
}

function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value);
}

function normalizeSentenceExceptions(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_SENTENCE_EXCEPTIONS];
  const seen = new Set(DEFAULT_SENTENCE_EXCEPTIONS);
  const out = [...DEFAULT_SENTENCE_EXCEPTIONS];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const word = entry.trim();
    if (!word || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

function pickThinking(v: unknown): TranslateThinking {
  return v === 'off' ||
    v === 'low' ||
    v === 'medium' ||
    v === 'high' ||
    v === 'xhigh'
    ? v
    : DEFAULT_TRANSLATE_SETTINGS.thinking;
}

function pickCtxLevel(v: unknown): TranslateContextLevel {
  return v === 'none' || v === 'paragraph' || v === 'page'
    ? v
    : DEFAULT_TRANSLATE_SETTINGS.ctxLevel;
}

function pickTriggerMode(v: unknown): TranslateTriggerMode {
  return v === 'double' ? 'double' : DEFAULT_TRANSLATE_SETTINGS.triggerMode;
}

function pickPosition(v: unknown): TranslateOverlayPosition {
  return v === "below" || v === "left" || v === "right" || v === "auto"
    ? v
    : "above";
}

function pickOverlaySize(v: unknown): TranslateOverlaySize {
  return v === 'adaptive' ? 'adaptive' : DEFAULT_TRANSLATE_SETTINGS.overlaySize;
}
