// Join Zotero local filesystem paths without mixing Windows and POSIX
// separators. Zotero's file APIs can reject `C:\Users\...\Zotero/foo.json`.

export function appendLocalPath(root: string, ...parts: string[]): string {
  const sep = root.includes("\\") ? "\\" : "/";
  const base = root.replace(/[\\/]+$/g, "");
  const suffix = parts
    .flatMap((part) => part.split(/[\\/]+/))
    .filter(Boolean)
    .join(sep);
  if (!suffix) return base || sep;
  return base ? `${base}${sep}${suffix}` : `${sep}${suffix}`;
}

export function localDirname(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : "";
}
