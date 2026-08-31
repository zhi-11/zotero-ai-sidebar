import type { PdfRect } from "../context/pdf-locator";
import type { QuestionAnnotationType } from "../settings/types";
import type { QuestionAnswerEntry } from "./translator";

export interface TranslationAnnotationDraft {
  text: string;
  attachmentID: number;
  pageLabel: string;
  pageIndex: number;
  rects: PdfRect[];
  sortIndex: string;
}

interface ZoteroAnnotationItem {
  id: number;
  annotationType?: string;
  annotationText?: string;
  annotationComment?: string;
  annotationPageLabel?: string;
  annotationPosition?: string;
  annotationSortIndex?: string | number;
  getAnnotations?(includeTrashed?: boolean): ZoteroAnnotationItem[];
  saveTx?(): Promise<unknown>;
}

interface ZoteroAnnotationAPI {
  Items: {
    getAsync(id: number): Promise<ZoteroAnnotationItem | null>;
  };
  DataObjectUtilities: { generateKey(): string };
  Annotations: {
    DEFAULT_COLOR: string;
    saveFromJSON(
      attachment: ZoteroAnnotationItem,
      json: Record<string, unknown>,
    ): Promise<ZoteroAnnotationItem>;
  };
}

export async function saveTranslationHighlight(
  draft: TranslationAnnotationDraft,
  patch: { comment: string; color?: string },
): Promise<{ id: number }> {
  const Z = getZoteroAnnotationAPI();
  const attachment = await Z.Items.getAsync(draft.attachmentID);
  if (!attachment) {
    throw new Error(`PDF attachment ${draft.attachmentID} was not found.`);
  }

  const key = Z.DataObjectUtilities.generateKey();
  const json = {
    id: key,
    key,
    type: "highlight",
    text: draft.text,
    comment: patch.comment,
    color: patch.color || Z.Annotations.DEFAULT_COLOR,
    pageLabel: draft.pageLabel,
    sortIndex: draft.sortIndex,
    position: {
      pageIndex: draft.pageIndex,
      rects: draft.rects,
    },
  };

  const item = await Z.Annotations.saveFromJSON(
    attachment,
    annotationJSONForZotero(json),
  );
  return { id: item.id };
}

export async function appendQuestionAnswerAnnotation(
  draft: TranslationAnnotationDraft,
  patch: {
    entries: QuestionAnswerEntry[];
    type: QuestionAnnotationType;
    color: string;
  },
): Promise<{ id: number; created: boolean; appended: number }> {
  const Z = getZoteroAnnotationAPI();
  const attachment = await Z.Items.getAsync(draft.attachmentID);
  if (!attachment) {
    throw new Error(`PDF attachment ${draft.attachmentID} was not found.`);
  }

  const existing = attachment
    .getAnnotations?.(false)
    .find((annotation) => sameTextSelection(annotation, draft));
  const currentComment = existing?.annotationComment?.trim() ?? "";
  const blocks = patch.entries
    .map(formatQuestionAnswer)
    .filter((block) => block && !currentComment.includes(block));
  if (existing) {
    if (!blocks.length) {
      return { id: existing.id, created: false, appended: 0 };
    }
    existing.annotationComment = [currentComment, ...blocks]
      .filter(Boolean)
      .join("\n");
    if (!existing.saveTx)
      throw new Error("Existing annotation cannot be saved.");
    await existing.saveTx();
    return { id: existing.id, created: false, appended: blocks.length };
  }

  if (!blocks.length)
    throw new Error("No question and answer content to save.");
  const key = Z.DataObjectUtilities.generateKey();
  const json = {
    id: key,
    key,
    type: patch.type,
    text: draft.text,
    comment: blocks.join("\n"),
    color: patch.color || Z.Annotations.DEFAULT_COLOR,
    pageLabel: draft.pageLabel,
    sortIndex: draft.sortIndex,
    position: {
      pageIndex: draft.pageIndex,
      rects: draft.rects,
    },
  };
  const item = await Z.Annotations.saveFromJSON(
    attachment,
    annotationJSONForZotero(json),
  );
  return { id: item.id, created: true, appended: blocks.length };
}

export function formatQuestionAnswer(entry: QuestionAnswerEntry): string {
  return `<b>Q：${stripRichTextMarkup(entry.question.trim())}</b>\nA：${stripRichTextMarkup(
    entry.answer.trim(),
  )}`;
}

function stripRichTextMarkup(text: string): string {
  return text.replace(/<\/?(?:b|i|sub|sup)>/gi, "");
}

function sameTextSelection(
  annotation: ZoteroAnnotationItem,
  draft: TranslationAnnotationDraft,
): boolean {
  if (
    annotation.annotationType !== "highlight" &&
    annotation.annotationType !== "underline"
  ) {
    return false;
  }
  if (
    normalizeText(annotation.annotationText ?? "") !== normalizeText(draft.text)
  ) {
    return false;
  }
  if (
    annotation.annotationPageLabel &&
    annotation.annotationPageLabel !== draft.pageLabel
  ) {
    return false;
  }
  const position = parsePosition(annotation.annotationPosition);
  if (!position) {
    return annotation.annotationSortIndex == null
      ? true
      : String(annotation.annotationSortIndex) === draft.sortIndex;
  }
  if (position.pageIndex !== draft.pageIndex) return false;
  return rectListsMatch(position.rects, draft.rects);
}

function parsePosition(
  raw: string | undefined,
): { pageIndex: number; rects: number[][] } | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { pageIndex?: unknown; rects?: unknown };
    if (typeof value.pageIndex !== "number" || !Array.isArray(value.rects)) {
      return null;
    }
    return { pageIndex: value.pageIndex, rects: value.rects as number[][] };
  } catch {
    return null;
  }
}

function rectListsMatch(a: number[][], b: PdfRect[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((rect, index) => {
    const expected = b[index] as number[] | undefined;
    return (
      !!expected &&
      rect.length === expected.length &&
      rect.every(
        (value, coordinate) =>
          Math.abs(value - (expected[coordinate] ?? Number.NaN)) < 0.5,
      )
    );
  });
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function getZoteroAnnotationAPI(): ZoteroAnnotationAPI {
  return (globalThis as unknown as { Zotero: ZoteroAnnotationAPI }).Zotero;
}

function annotationJSONForZotero(
  json: Record<string, unknown>,
): Record<string, unknown> {
  const plain = JSON.parse(JSON.stringify(json)) as Record<string, unknown>;
  const chromeWin = (
    globalThis as unknown as {
      Zotero?: { getMainWindow?: () => Window | null };
    }
  ).Zotero?.getMainWindow?.();
  try {
    const cloneInto = (
      chromeWin as unknown as {
        Components?: { utils?: { cloneInto?: Function } };
      } | null
    )?.Components?.utils?.cloneInto;
    if (cloneInto && chromeWin) return cloneInto(plain, chromeWin);
  } catch {
    /* fall through */
  }
  return chromeWin?.JSON?.parse
    ? chromeWin.JSON.parse(JSON.stringify(plain))
    : plain;
}
