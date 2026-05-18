import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_NOTE_TITLE, resolveTargetNote } from "../../src/modules/note-dedicated";

const LINKS_KEY = "extensions.zotero-ai-sidebar.dedicatedNoteLinks";

class MockItem {
  id: number;
  key: string;
  libraryID = 1;
  parentID?: number;
  deleted = false;
  type: "regular" | "note";
  noteHTML = "";
  noteIDs: number[] = [];
  dateModified = "2026-05-18T00:00:00Z";

  constructor(type: "regular" | "note", id: number, key: string) {
    this.type = type;
    this.id = id;
    this.key = key;
  }

  isNote() {
    return this.type === "note";
  }

  isAttachment() {
    return false;
  }

  getNotes() {
    return [...this.noteIDs];
  }

  getNote() {
    return this.noteHTML;
  }

  setNote(html: string) {
    this.noteHTML = html;
  }

  getNoteTitle() {
    const h1 = this.noteHTML.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "";
    return h1.replace(/<[^>]+>/g, "").trim();
  }

  async saveTx() {
    this.dateModified = new Date().toISOString();
  }
}

describe("dedicated note resolution", () => {
  let items: Map<number, MockItem>;
  let itemsByKey: Map<string, MockItem>;
  let prefs: Map<string, string>;
  let parent: MockItem;

  beforeEach(() => {
    items = new Map();
    itemsByKey = new Map();
    prefs = new Map();
    parent = addItem(new MockItem("regular", 125, "PARENT"));

    vi.stubGlobal("Zotero", {
      Item: class extends MockItem {
        constructor(type: "regular" | "note") {
          super(type, 9000 + items.size, `NEW${items.size}`);
          addItem(this);
        }
      },
      Items: {
        get: (id: number | number[]) => {
          if (Array.isArray(id)) {
            return id.map((value) => items.get(value)).filter(Boolean);
          }
          return items.get(id) ?? false;
        },
      },
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: string) => prefs.set(key, value),
      },
      URI: {
        getItemURI: (item: MockItem) =>
          `zotero://select/library/items/${item.key}`,
        getURIItem: async (uri: string) => {
          const key = uri.split("/").pop() ?? "";
          return itemsByKey.get(key) ?? false;
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function addItem<T extends MockItem>(item: T): T {
    items.set(item.id, item);
    itemsByKey.set(item.key, item);
    return item;
  }

  function childNote(
    id: number,
    key: string,
    html = `<h1>${AI_NOTE_TITLE}</h1>`,
  ): MockItem {
    const note = addItem(new MockItem("note", id, key));
    note.parentID = parent.id;
    note.noteHTML = html;
    parent.noteIDs.push(note.id);
    return note;
  }

  function itemURI(item: MockItem): string {
    return `zotero://select/library/items/${item.key}`;
  }

  it("keeps a saved pointer even when the body marker was stripped", async () => {
    const linked = childNote(201, "LINKED");
    const legacyWithContent = childNote(
      202,
      "LEGACY",
      `<h1>${AI_NOTE_TITLE}</h1><p>old content</p>`,
    );
    prefs.set(
      LINKS_KEY,
      JSON.stringify({
        [itemURI(parent)]: {
          ai: { noteID: linked.id, noteURI: itemURI(linked) },
        },
      }),
    );

    const result = await resolveTargetNote(parent.id);

    expect(result.note.id).toBe(linked.id);
    expect(result.note.id).not.toBe(legacyWithContent.id);
  });

  it("migrates an unlinked legacy AI note when no pointer exists", async () => {
    const legacy = childNote(301, "LEGACY");

    const result = await resolveTargetNote(parent.id);

    expect(result.note.id).toBe(legacy.id);
    expect(legacy.getNote()).toContain('data-zai-dedicated-note="ai"');
    expect(JSON.parse(prefs.get(LINKS_KEY) ?? "{}")).toMatchObject({
      [itemURI(parent)]: {
        ai: { noteID: legacy.id, noteURI: itemURI(legacy) },
      },
    });
  });
});
