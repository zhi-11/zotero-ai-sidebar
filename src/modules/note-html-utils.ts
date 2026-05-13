export function renderEditableNoteHTML(target: HTMLElement, html: string) {
  target.replaceChildren();
  const doc = target.ownerDocument!;
  const Parser = doc.defaultView?.DOMParser;
  if (!html.trim() || !Parser) return;
  const parsed = new Parser().parseFromString(html, "text/html");
  if (parsed.body) appendSanitizedNoteChildren(doc, target, parsed.body);
}

export function editableNoteHTML(editor: HTMLElement): string {
  const doc = editor.ownerDocument!;
  const scratch = doc.createElement("div");
  appendSanitizedNoteChildren(doc, scratch, editor);
  return isEditableNoteEmpty(scratch) ? "" : String(scratch.innerHTML).trim();
}

function isEditableNoteEmpty(element: HTMLElement): boolean {
  if (element.querySelector("table, hr, blockquote, pre, ul, ol")) return false;
  return !(element.textContent || "").replace(/\u200b/g, "").trim();
}

export function insertPlainTextAtSelection(doc: Document, text: string) {
  if (doc.execCommand?.("insertText", false, text)) return;
  const selection = doc.getSelection?.();
  if (!selection || !selection.rangeCount) return;
  selection.deleteFromDocument();
  selection.getRangeAt(0).insertNode(doc.createTextNode(text));
  selection.collapseToEnd();
}

export function installNoteEditorEventIsolation(
  doc: Document,
  editor: HTMLElement,
  saveNow: () => void,
): () => void {
  const stopBubble = (event: Event) => {
    event.stopPropagation();
  };
  const stopKeyboardBubble = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveNow();
    }
    // Do not stop the event in capture phase: Firefox/contenteditable needs the
    // normal target phase for Enter, Backspace/Delete and list editing.
    event.stopPropagation();
  };
  const ensureEditorFocus = () => {
    if (doc.activeElement === editor) return;
    const selection = doc.getSelection?.();
    if (selection?.anchorNode && !editor.contains(selection.anchorNode)) return;
    editor.focus({ preventScroll: true });
  };

  for (const type of [
    "mousedown",
    "mouseup",
    "click",
    "dblclick",
    "pointerdown",
    "pointerup",
  ]) {
    editor.addEventListener(type, stopBubble);
  }
  editor.addEventListener("focus", stopBubble);
  editor.addEventListener("click", ensureEditorFocus);
  editor.addEventListener("keydown", stopKeyboardBubble);
  editor.addEventListener("keypress", stopBubble);
  editor.addEventListener("keyup", stopBubble);

  return () => {
    for (const type of [
      "mousedown",
      "mouseup",
      "click",
      "dblclick",
      "pointerdown",
      "pointerup",
    ]) {
      editor.removeEventListener(type, stopBubble);
    }
    editor.removeEventListener("focus", stopBubble);
    editor.removeEventListener("click", ensureEditorFocus);
    editor.removeEventListener("keydown", stopKeyboardBubble);
    editor.removeEventListener("keypress", stopBubble);
    editor.removeEventListener("keyup", stopBubble);
  };
}

interface EditableSelectionSnapshot {
  anchorPath: number[];
  anchorOffset: number;
  focusPath: number[];
  focusOffset: number;
}

export function saveEditableSelection(
  root: HTMLElement,
): EditableSelectionSnapshot | null {
  const selection = root.ownerDocument?.getSelection?.();
  if (
    !selection ||
    !selection.anchorNode ||
    !selection.focusNode ||
    !root.contains(selection.anchorNode) ||
    !root.contains(selection.focusNode)
  ) {
    return null;
  }
  const anchorPath = nodePathFromRoot(root, selection.anchorNode);
  const focusPath = nodePathFromRoot(root, selection.focusNode);
  if (!anchorPath || !focusPath) return null;
  return {
    anchorPath,
    anchorOffset: selection.anchorOffset,
    focusPath,
    focusOffset: selection.focusOffset,
  };
}

export function restoreEditableSelection(
  root: HTMLElement,
  snapshot: EditableSelectionSnapshot | null,
) {
  if (!snapshot || !root.isConnected) return;
  const restore = () => {
    if (!root.isConnected) return;
    const anchor = nodeFromRootPath(root, snapshot.anchorPath);
    const focus = nodeFromRootPath(root, snapshot.focusPath);
    if (!anchor || !focus) return;
    const anchorOffset = clampNodeOffset(anchor, snapshot.anchorOffset);
    const focusOffset = clampNodeOffset(focus, snapshot.focusOffset);
    root.focus({ preventScroll: true });
    const selection = root.ownerDocument?.getSelection?.();
    if (!selection) return;
    const selectionWithExtent = selection as Selection & {
      setBaseAndExtent?: (
        anchorNode: Node,
        anchorOffset: number,
        focusNode: Node,
        focusOffset: number,
      ) => void;
    };
    if (selectionWithExtent.setBaseAndExtent) {
      selectionWithExtent.setBaseAndExtent(
        anchor,
        anchorOffset,
        focus,
        focusOffset,
      );
      return;
    }
    const range = root.ownerDocument!.createRange();
    range.setStart(anchor, anchorOffset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  };
  restore();
  const win = root.ownerDocument?.defaultView;
  win?.requestAnimationFrame?.(restore);
  win?.setTimeout(restore, 80);
}

export function restoreEditableSelectionIfLost(
  root: HTMLElement,
  snapshot: EditableSelectionSnapshot | null,
) {
  if (hasEditableSelection(root)) return;
  restoreEditableSelection(root, snapshot);
}

function hasEditableSelection(root: HTMLElement): boolean {
  const selection = root.ownerDocument?.getSelection?.();
  return !!(
    selection?.anchorNode &&
    selection.focusNode &&
    root.contains(selection.anchorNode) &&
    root.contains(selection.focusNode)
  );
}

function nodePathFromRoot(root: Node, node: Node): number[] | null {
  const path: number[] = [];
  let current: Node | null = node;
  while (current && current !== root) {
    const parent: Node | null = current.parentNode;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
    current = parent;
  }
  return current === root ? path : null;
}

function nodeFromRootPath(root: Node, path: number[]): Node | null {
  let current: Node = root;
  for (const index of path) {
    const child = current.childNodes.item(index);
    if (!child) return null;
    current = child;
  }
  return current;
}

function clampNodeOffset(node: Node, offset: number): number {
  const max =
    node.nodeType === Node.TEXT_NODE
      ? (node.textContent || "").length
      : node.childNodes.length;
  return Math.max(0, Math.min(offset, max));
}

function appendSanitizedNoteChildren(
  doc: Document,
  target: HTMLElement,
  source: Node,
) {
  const children = Array.from(source.childNodes).filter(
    (node): node is Node => !!node,
  );
  for (const child of children) {
    if (child.nodeType === 3) {
      target.append(doc.createTextNode(child.textContent || ""));
      continue;
    }
    if (child.nodeType !== 1) continue;

    const sourceEl = child as Element;
    const tag = sourceEl.tagName.toLowerCase();
    if (!ALLOWED_NOTE_TAGS.has(tag)) {
      appendSanitizedNoteChildren(doc, target, sourceEl);
      continue;
    }

    const clone = doc.createElement(tag);
    copySafeNoteAttributes(sourceEl, clone);
    appendSanitizedNoteChildren(doc, clone, sourceEl);
    target.append(clone);
  }
}

const ALLOWED_NOTE_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "col",
  "colgroup",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);

function copySafeNoteAttributes(source: Element, target: HTMLElement) {
  for (const attr of Array.from(source.attributes)) {
    const name = attr.name.toLowerCase();
    const value = attr.value;
    if (name.startsWith("on")) continue;
    if (name === "href") {
      if (!isSafeNoteUrl(value)) continue;
      target.setAttribute("href", value);
      target.setAttribute("rel", "noreferrer");
      target.setAttribute("target", "_blank");
      continue;
    }
    if (name.startsWith("data-")) {
      target.setAttribute(name, value);
      continue;
    }
    if (
      name === "style" &&
      !/url\s*\(|expression\s*\(/i.test(value)
    ) {
      target.setAttribute(name, value);
      continue;
    }
    if (["alt", "class", "colspan", "rowspan", "title"].includes(name)) {
      target.setAttribute(name, value);
    }
  }
}

function isSafeNoteUrl(value: string): boolean {
  const url = value.trim().toLowerCase();
  return !!url && !url.startsWith("javascript:") && !url.startsWith("data:");
}
