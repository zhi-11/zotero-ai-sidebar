import { debugZai, errorMessage, htmlStringDebugInfo, textDebugInfo } from "./debug-utils";

export interface PendingSidebarCopy {
  text: string;
  label: string;
  html?: string;
}

let programmaticClipboardWrite = false;
let pendingSidebarCopy: PendingSidebarCopy | null = null;

export async function copyToClipboard(
  doc: Document,
  text: string,
  debugLabel?: string,
  html?: string,
) {
  if (debugLabel) {
    debugZai(`${debugLabel}: clipboard-write:start`, {
      text: textDebugInfo(text),
      html: html ? htmlStringDebugInfo(html) : null,
    });
  }
  if (html) {
    const copiedRich = copyRichTextViaExecCommand(doc, text, html, debugLabel);
    if (copiedRich) return;
  }
  const clipboard = doc.defaultView?.navigator.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      if (debugLabel) {
        debugZai(`${debugLabel}: clipboard-write:writeText-ok`, {
          length: text.length,
        });
      }
      return;
    } catch (err) {
      // Zotero/Firefox chrome documents can expose navigator.clipboard but
      // still reject writeText(). Fall through to the execCommand path.
      if (debugLabel) {
        debugZai(`${debugLabel}: clipboard-write:writeText-failed`, {
          error: errorMessage(err),
        });
      }
    }
  }

  const textarea = doc.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  const root = doc.body ?? doc.documentElement;
  if (!root) {
    if (debugLabel) debugZai(`${debugLabel}: clipboard-write:no-root`);
    return;
  }
  root.append(textarea);
  textarea.select();
  programmaticClipboardWrite = true;
  try {
    const ok = doc.execCommand("copy");
    if (debugLabel) {
      debugZai(`${debugLabel}: clipboard-write:execCommand`, { ok });
    }
  } finally {
    programmaticClipboardWrite = false;
    textarea.remove();
  }
}

function copyRichTextViaExecCommand(
  doc: Document,
  text: string,
  html: string,
  debugLabel?: string,
): boolean {
  const root = doc.body ?? doc.documentElement;
  if (!root) {
    if (debugLabel) debugZai(`${debugLabel}: clipboard-write:no-root`);
    return false;
  }

  let wrote = false;
  const onCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.clipboardData.setData("text/plain", text);
    event.clipboardData.setData("text/html", html);
    wrote = true;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  const textarea = doc.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  root.append(textarea);
  textarea.select();
  doc.addEventListener("copy", onCopy, true);
  programmaticClipboardWrite = true;
  try {
    const ok = doc.execCommand("copy");
    if (debugLabel) {
      debugZai(`${debugLabel}: clipboard-write:rich-execCommand`, {
        ok,
        wrote,
      });
    }
    return ok && wrote;
  } finally {
    programmaticClipboardWrite = false;
    doc.removeEventListener("copy", onCopy, true);
    textarea.remove();
  }
}

export function flashButton(button: HTMLButtonElement, text: string) {
  const original = button.textContent || "";
  button.textContent = text;
  button.disabled = true;
  button.ownerDocument?.defaultView?.setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, 900);
}


export function isProgrammaticClipboardWrite(): boolean {
  return programmaticClipboardWrite;
}

export function getPendingSidebarCopy(): PendingSidebarCopy | null {
  return pendingSidebarCopy;
}

export function setPendingSidebarCopy(copy: PendingSidebarCopy): void {
  pendingSidebarCopy = copy;
}

export function clearPendingSidebarCopy(): void {
  pendingSidebarCopy = null;
}

