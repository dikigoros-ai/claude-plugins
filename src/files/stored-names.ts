// The document filenames a selection is stored under: two files with the same name from different
// folders (Pleadings/Αγωγή.pdf, Old/Αγωγή.pdf) must not land in the matter under one name, so the
// later one gets " (2)" before its extension, and so on.

/**
 * For each selected file, in order, its document filename: the bare name, or with " (n)" before the
 * extension when an earlier file of this selection or `taken` (storedName → relativePath, from the link)
 * holds it for another relative path. Compared case-insensitively (NFC). A name `taken` holds for the
 * same relative path is not a clash, so a file keeps its name on a re-run. The returned map is keyed by
 * relative path.
 */
export function assignStoredNames(
  selected: ReadonlyArray<{ relativePath: string; name: string }>,
  taken: ReadonlyMap<string, string>,
): Map<string, string> {
  // Who holds each name, by comparison key: the link's names first, then this selection's as assigned.
  const holders = new Map<string, string>();
  for (const [storedName, relativePath] of taken) holders.set(nameKey(storedName), relativePath);
  const assigned = new Set<string>();
  const result = new Map<string, string>();
  for (const { relativePath, name } of selected) {
    const isFree = (candidate: string): boolean => {
      const key = nameKey(candidate);
      if (assigned.has(key)) return false;
      const holder = holders.get(key);
      return holder === undefined || holder === relativePath;
    };
    let storedName = name;
    for (let n = 2; !isFree(storedName); n++) storedName = numbered(name, n);
    assigned.add(nameKey(storedName));
    result.set(relativePath, storedName);
  }
  return result;
}

/** The key two names are compared by: NFC, lower case. */
function nameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/** `name` with " (n)" before its extension (the text after the last dot that is not the first
 *  character), or at its end when it has none. */
function numbered(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name} (${n})`;
  return `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
}
