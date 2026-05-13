import { zoteroPrefs } from "../settings/storage";

export const AI_NOTE_TITLE = "AI 笔记";
export const READING_ROUTE_NOTE_TITLE = "AI 阅读路线";
export const READING_ROUTE_MANUAL_HEADING = "我的补充笔记";
const DEDICATED_NOTE_LINKS_KEY =
  "extensions.zotero-ai-sidebar.dedicatedNoteLinks";
const AI_NOTE_MARKER = "zotero-ai-sidebar:dedicated-note:ai";
const READING_ROUTE_NOTE_MARKER =
  "zotero-ai-sidebar:dedicated-note:reading-route";

export type DedicatedNoteKind = "ai" | "readingRoute";

export async function resolveTargetNote(
  itemID: number | null,
): Promise<{ note: Zotero.Item; created: boolean }> {
  return resolveDedicatedNote(itemID, "ai", true);
}

export function isAiNote(note: Zotero.Item): boolean {
  return hasDedicatedNoteMarker(note, "ai");
}

export function getZoteroItem(itemID: number): Zotero.Item | null {
  const item = Zotero.Items.get(itemID) as Zotero.Item | false | undefined;
  return item || null;
}

export function isStandaloneAttachment(item: Zotero.Item): boolean {
  const i = item as Zotero.Item & { isAttachment?: () => boolean };
  return !!(i.isAttachment?.() && itemParentID(item) == null);
}

export async function createParentForStandalonePDF(
  pdf: Zotero.Item,
): Promise<Zotero.Item> {
  const ZItem = (Zotero as unknown as { Item: new (type: string) => any }).Item;
  const parent = new ZItem("document") as Zotero.Item;
  parent.libraryID = pdf.libraryID;
  const title =
    (pdf as any).getField?.("title") ||
    (pdf as any).getDisplayTitle?.() ||
    "";
  if (title) (parent as any).setField?.("title", title);
  const collectionIDs = (pdf as any).getCollections?.() as number[] | undefined;
  if (collectionIDs?.length) (parent as any).setCollections?.(collectionIDs);
  await parent.saveTx();

  // Move the PDF under the new parent.
  (pdf as any).parentID = parent.id;
  await pdf.saveTx();

  return parent;
}

export function parentItemForNotes(item: Zotero.Item): Zotero.Item {
  const maybeAttachment = item as Zotero.Item & {
    isAttachment?: () => boolean;
  };
  const parentID = itemParentID(item);
  if (maybeAttachment.isAttachment?.() && parentID) {
    return getZoteroItem(parentID) ?? item;
  }
  return item;
}

export function childNotesForItem(item: Zotero.Item): Zotero.Item[] {
  const getNotes = (item as Zotero.Item & { getNotes?: () => unknown })
    .getNotes;
  if (!getNotes) return [];

  const ids = getNotes.call(item);
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const notes = Zotero.Items.get(ids as number[]) as
    | Zotero.Item[]
    | Zotero.Item
    | false
    | undefined;
  const items = Array.isArray(notes) ? notes : notes ? [notes] : [];
  return items.filter(isZoteroNote);
}

export function isZoteroNote(
  item: Zotero.Item | null | undefined,
): item is Zotero.Item {
  return !!item && (item as Zotero.Item & { isNote?: () => boolean }).isNote?.();
}

export async function createChildNote(parent: Zotero.Item): Promise<Zotero.Item> {
  return createNamedChildNote(parent, AI_NOTE_TITLE, "ai");
}

export function noteTitle(note: Zotero.Item): string {
  const title = (note as Zotero.Item & { getNoteTitle?: () => string })
    .getNoteTitle?.();
  return title || `Zotero 笔记 #${note.id}`;
}

async function resolveDedicatedNote(
  itemID: number | null,
  kind: DedicatedNoteKind,
  createIfMissing: true,
): Promise<{ note: Zotero.Item; created: boolean }>;
async function resolveDedicatedNote(
  itemID: number | null,
  kind: DedicatedNoteKind,
  createIfMissing: false,
): Promise<{ note: Zotero.Item; created: boolean } | null>;
async function resolveDedicatedNote(
  itemID: number | null,
  kind: DedicatedNoteKind,
  createIfMissing: boolean,
): Promise<{ note: Zotero.Item; created: boolean } | null> {
  if (itemID == null) {
    if (createIfMissing) throw new Error("未选择 Zotero 条目");
    return null;
  }
  const item = getZoteroItem(itemID);
  if (!item) {
    if (createIfMissing) throw new Error(`找不到 Zotero 条目 #${itemID}`);
    return null;
  }

  const parent = createIfMissing
    ? await parentItemForDedicatedNotes(item)
    : parentItemForDedicatedLookup(item);
  if (!parent) return null;

  const linked = await linkedDedicatedNote(parent, kind);
  const childNotes = childNotesForItem(parent);
  const scanned = childNotes.find((note) =>
    isUsableDedicatedNote(note, parent, kind),
  );

  if (kind === "ai") {
    const markerNote = linked ?? scanned ?? null;
    const legacy = findLegacyAiNote(childNotes);
    if (legacy && (!markerNote || isEffectivelyEmptyNote(markerNote, "ai"))) {
      await ensureDedicatedNoteMarker(legacy, "ai");
      saveDedicatedNoteLink(parent, "ai", legacy);
      return { note: legacy, created: false };
    }
  }

  if (linked) return { note: linked, created: false };

  if (scanned) {
    saveDedicatedNoteLink(parent, kind, scanned);
    return { note: scanned, created: false };
  }

  if (!createIfMissing) return null;

  const note = await createNamedChildNote(
    parent,
    dedicatedNoteTitle(kind),
    kind,
  );
  saveDedicatedNoteLink(parent, kind, note);
  return { note, created: true };
}

async function linkedDedicatedNote(
  parent: Zotero.Item,
  kind: DedicatedNoteKind,
): Promise<Zotero.Item | null> {
  const pointer = loadDedicatedNoteLinks()[dedicatedParentKey(parent)]?.[kind];
  if (!pointer) return null;
  const note = await noteFromDedicatedPointer(pointer);
  if (!isUsableDedicatedNote(note, parent, kind)) {
    clearDedicatedNoteLink(parent, kind);
    return null;
  }
  return note;
}

async function noteFromDedicatedPointer(pointer: {
  noteID?: number;
  noteURI?: string;
}): Promise<Zotero.Item | null> {
  if (pointer.noteURI) {
    try {
      const item = await (Zotero as any).URI.getURIItem(pointer.noteURI);
      if (item) return item as Zotero.Item;
    } catch {
      // Fall back to the local numeric ID below.
    }
  }
  return typeof pointer.noteID === "number" ? getZoteroItem(pointer.noteID) : null;
}

function saveDedicatedNoteLink(
  parent: Zotero.Item,
  kind: DedicatedNoteKind,
  note: Zotero.Item,
): void {
  const links = loadDedicatedNoteLinks();
  const parentKey = dedicatedParentKey(parent);
  links[parentKey] = {
    ...(links[parentKey] ?? {}),
    [kind]: {
      noteID: note.id,
      noteURI: itemURI(note),
      savedAt: Date.now(),
    },
  };
  zoteroPrefs().set(DEDICATED_NOTE_LINKS_KEY, JSON.stringify(links));
}

function clearDedicatedNoteLink(parent: Zotero.Item, kind: DedicatedNoteKind): void {
  const links = loadDedicatedNoteLinks();
  const parentKey = dedicatedParentKey(parent);
  if (!links[parentKey]?.[kind]) return;
  delete links[parentKey]![kind];
  if (Object.keys(links[parentKey]!).length === 0) {
    delete links[parentKey];
  }
  zoteroPrefs().set(DEDICATED_NOTE_LINKS_KEY, JSON.stringify(links));
}

function loadDedicatedNoteLinks(): Record<
  string,
  Partial<Record<DedicatedNoteKind, { noteID?: number; noteURI?: string }>>
> {
  const raw = zoteroPrefs().get(DEDICATED_NOTE_LINKS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function dedicatedParentKey(parent: Zotero.Item): string {
  return itemURI(parent) || `local:${parent.libraryID}:${parent.key ?? parent.id}`;
}

function itemURI(item: Zotero.Item): string {
  try {
    return String((Zotero as any).URI.getItemURI(item) || "");
  } catch {
    return "";
  }
}

export function itemParentID(item: Zotero.Item): number | null {
  const direct = (item as Zotero.Item & { parentID?: number | false }).parentID;
  if (typeof direct === "number") return direct;
  const source = (item as Zotero.Item & { getSource?: () => unknown })
    .getSource?.();
  return typeof source === "number" ? source : null;
}

function noteBelongsToParent(note: Zotero.Item, parent: Zotero.Item): boolean {
  const parentID = itemParentID(note);
  if (parentID === parent.id) return true;
  const childIDs = (parent as Zotero.Item & { getNotes?: () => unknown })
    .getNotes?.();
  return Array.isArray(childIDs) && childIDs.some((id) => Number(id) === note.id);
}

function isUsableDedicatedNote(
  note: Zotero.Item | null | undefined,
  parent: Zotero.Item,
  kind: DedicatedNoteKind,
): note is Zotero.Item {
  return (
    isZoteroNote(note) &&
    !note.deleted &&
    noteBelongsToParent(note, parent) &&
    hasDedicatedNoteMarker(note, kind)
  );
}

function dedicatedNoteTitle(kind: DedicatedNoteKind): string {
  return kind === "ai" ? AI_NOTE_TITLE : READING_ROUTE_NOTE_TITLE;
}

function dedicatedNoteMarkerValue(kind: DedicatedNoteKind): string {
  return kind === "ai" ? AI_NOTE_MARKER : READING_ROUTE_NOTE_MARKER;
}

export function hasDedicatedNoteMarker(
  note: Zotero.Item,
  kind: DedicatedNoteKind,
): boolean {
  const html = note.getNote?.() || "";
  const marker = dedicatedNoteMarkerValue(kind);
  return (
    html.includes(`data-zai-dedicated-note="${kind}"`) ||
    html.includes(marker)
  );
}

function findLegacyAiNote(notes: Zotero.Item[]): Zotero.Item | null {
  const candidates = notes
    .filter(
      (note) =>
        !note.deleted &&
        !hasDedicatedNoteMarker(note, "ai") &&
        !hasDedicatedNoteMarker(note, "readingRoute") &&
        noteTitle(note).trim() === AI_NOTE_TITLE,
    )
    .sort((a, b) => {
      const aHasContent = noteContentLength(a, "ai") > 0;
      const bHasContent = noteContentLength(b, "ai") > 0;
      if (aHasContent !== bHasContent) return bHasContent ? 1 : -1;
      const timeDiff = noteModifiedTime(b) - noteModifiedTime(a);
      return timeDiff !== 0 ? timeDiff : b.id - a.id;
    });
  return candidates[0] ?? null;
}

function isEffectivelyEmptyNote(
  note: Zotero.Item,
  kind: DedicatedNoteKind,
): boolean {
  return noteContentLength(note, kind) === 0;
}

function noteContentLength(note: Zotero.Item, kind: DedicatedNoteKind): number {
  const title = dedicatedNoteTitle(kind);
  let text = notePlainText(note.getNote?.() || "");
  if (text.startsWith(title)) text = text.slice(title.length);
  return text.replace(/\s|\u200b/g, "").length;
}

function notePlainText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function noteModifiedTime(note: Zotero.Item): number {
  const raw =
    (note as any).dateModified ??
    (note as any).clientDateModified ??
    (note as any)._dateModified;
  const time = raw ? Date.parse(String(raw)) : NaN;
  return Number.isFinite(time) ? time : 0;
}

async function ensureDedicatedNoteMarker(
  note: Zotero.Item,
  kind: DedicatedNoteKind,
): Promise<void> {
  if (hasDedicatedNoteMarker(note, kind)) return;
  note.setNote(addDedicatedNoteMarkerToHTML(note.getNote?.() || "", kind));
  await note.saveTx();
}

function addDedicatedNoteMarkerToHTML(
  html: string,
  kind: DedicatedNoteKind,
): string {
  const marker = dedicatedNoteMarkerHTML(kind);
  const title = escapeHTML(dedicatedNoteTitle(kind));
  if (/<h1\b[^>]*>/i.test(html)) {
    return html.replace(/<h1\b([^>]*)>/i, `<h1$1>${marker}`);
  }
  return `<h1>${marker}${title}</h1>${html}`;
}

function dedicatedNoteMarkerHTML(kind: DedicatedNoteKind): string {
  return `<span data-zai-dedicated-note="${kind}" data-zai-dedicated-marker="${dedicatedNoteMarkerValue(kind)}"></span>`;
}

export function dedicatedNoteMarker(
  doc: Document,
  kind: DedicatedNoteKind,
): HTMLElement {
  const marker = doc.createElement("span");
  marker.setAttribute("data-zai-dedicated-note", kind);
  marker.setAttribute("data-zai-dedicated-marker", dedicatedNoteMarkerValue(kind));
  return marker;
}

export async function resolveReadingRouteNote(
  itemID: number | null,
): Promise<{ note: Zotero.Item; created: boolean }> {
  return resolveDedicatedNote(itemID, "readingRoute", true);
}

export async function findReadingRouteNote(
  itemID: number | null,
): Promise<Zotero.Item | null> {
  return (await resolveDedicatedNote(itemID, "readingRoute", false))?.note ?? null;
}

async function parentItemForDedicatedNotes(
  item: Zotero.Item,
): Promise<Zotero.Item> {
  const noteParentID = itemParentID(item);
  if (isZoteroNote(item) && noteParentID) {
    return getZoteroItem(noteParentID) ?? item;
  }
  if (isStandaloneAttachment(item)) {
    return createParentForStandalonePDF(item);
  }
  return parentItemForNotes(item);
}

export function parentItemForDedicatedLookup(
  item: Zotero.Item,
): Zotero.Item | null {
  const noteParentID = itemParentID(item);
  if (isZoteroNote(item) && noteParentID) {
    return getZoteroItem(noteParentID);
  }
  if (isStandaloneAttachment(item)) return null;
  return parentItemForNotes(item);
}

export function isReadingRouteNote(note: Zotero.Item): boolean {
  return hasDedicatedNoteMarker(note, "readingRoute");
}

async function createNamedChildNote(
  parent: Zotero.Item,
  title: string,
  kind: DedicatedNoteKind,
): Promise<Zotero.Item> {
  const note = new (Zotero as unknown as { Item: new (type: string) => any }).Item(
    "note",
  ) as Zotero.Item;
  note.libraryID = parent.libraryID;
  (note as Zotero.Item & { parentID?: number }).parentID = parent.id;
  note.setNote(
    `<h1>${dedicatedNoteMarkerHTML(kind)}${escapeHTML(title)}</h1>`,
  );
  await note.saveTx();
  return note;
}

function escapeHTML(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
