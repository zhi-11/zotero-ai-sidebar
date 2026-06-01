import type { PdfRect } from "../context/pdf-locator";

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

function getZoteroAnnotationAPI(): ZoteroAnnotationAPI {
  return (globalThis as unknown as { Zotero: ZoteroAnnotationAPI }).Zotero;
}

function annotationJSONForZotero(
  json: Record<string, unknown>,
): Record<string, unknown> {
  const plain = JSON.parse(JSON.stringify(json)) as Record<string, unknown>;
  const chromeWin = (globalThis as unknown as {
    Zotero?: { getMainWindow?: () => Window | null };
  }).Zotero?.getMainWindow?.();
  try {
    const cloneInto = (chromeWin as unknown as {
      Components?: { utils?: { cloneInto?: Function } };
    } | null)?.Components?.utils?.cloneInto;
    if (cloneInto && chromeWin) return cloneInto(plain, chromeWin);
  } catch {
    /* fall through */
  }
  return chromeWin?.JSON?.parse
    ? chromeWin.JSON.parse(JSON.stringify(plain))
    : plain;
}
