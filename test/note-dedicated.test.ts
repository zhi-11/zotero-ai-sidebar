import { assert } from "chai";
import {
  AI_NOTE_TITLE,
  resolveTargetNote,
} from "../src/modules/note-dedicated";

const DEDICATED_NOTE_LINKS_KEY =
  "extensions.zotero-ai-sidebar.dedicatedNoteLinks";

describe("dedicated AI note resolution in Zotero", function () {
  it("keeps the saved note pointer when Zotero strips the body marker", async function () {
    const previousLinks = Zotero.Prefs.get(DEDICATED_NOTE_LINKS_KEY, true);
    const createdItems: Zotero.Item[] = [];

    try {
      const parent = new Zotero.Item("document");
      parent.libraryID = Zotero.Libraries.userLibraryID;
      parent.setField("title", "ZAI dedicated note pointer regression");
      await parent.saveTx();
      createdItems.push(parent);

      const linked = new Zotero.Item("note");
      linked.libraryID = parent.libraryID;
      linked.parentID = parent.id;
      linked.setNote(`<h1>${AI_NOTE_TITLE}</h1>`);
      await linked.saveTx();
      createdItems.push(linked);

      const legacy = new Zotero.Item("note");
      legacy.libraryID = parent.libraryID;
      legacy.parentID = parent.id;
      legacy.setNote(`<h1>${AI_NOTE_TITLE}</h1><p>legacy content</p>`);
      await legacy.saveTx();
      createdItems.push(legacy);

      const parentURI = Zotero.URI.getItemURI(parent);
      const linkedURI = Zotero.URI.getItemURI(linked);
      Zotero.Prefs.set(
        DEDICATED_NOTE_LINKS_KEY,
        JSON.stringify({
          [parentURI]: {
            ai: {
              noteID: linked.id,
              noteURI: linkedURI,
            },
          },
        }),
        true,
      );

      const result = await resolveTargetNote(parent.id);

      assert.strictEqual(result.note.id, linked.id);
      assert.notStrictEqual(result.note.id, legacy.id);
    } finally {
      if (typeof previousLinks === "string") {
        Zotero.Prefs.set(DEDICATED_NOTE_LINKS_KEY, previousLinks, true);
      } else {
        Zotero.Prefs.clear(DEDICATED_NOTE_LINKS_KEY, true);
      }
      for (const item of createdItems.reverse()) {
        if (!item.deleted) await item.eraseTx();
      }
    }
  });
});
