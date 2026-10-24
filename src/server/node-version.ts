// The oldest Node.js the helper runs on: 22.13, which pdfjs-dist 6 needs (package.json `engines`).
// The bundle checks it before anything else, so that an older Node.js gets one line saying so rather
// than a failure that says nothing of it.

/** The oldest supported version, as major, minor and patch. */
const OLDEST = [22, 13, 0];

/** Whether `version`, as process.versions.node spells it ("22.13.0", a pre-release's suffix aside), is supported. */
export function isSupportedNode(version: string): boolean {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  for (const [i, oldest] of OLDEST.entries()) {
    const part = parts[i] ?? 0;
    if (part !== oldest) return part > oldest;
  }
  return true;
}
