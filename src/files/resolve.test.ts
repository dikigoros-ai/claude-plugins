import { appendFile, chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MAX_FILE_BYTES, MAX_FILES_PER_CALL, type PlanEntry, planDigest, resolveUploadPlan } from "./resolve";

const PDF = "%PDF-1.7\n%test\n";
const DOCX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]); // the ZIP header every .docx starts with

// Root reads through any permission bits, so a chmod 000 lock does not hold for it.
const asRoot = process.getuid?.() === 0;

// Each test builds its own tree. `root` is the tree as a caller names it; `realRoot` is where it
// really is (on macOS os.tmpdir() sits behind the /var -> /private/var symlink, so the two differ).
let root: string;
let realRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dikigoros-resolve-"));
  realRoot = await realpath(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Writes `content` at `rel` under the tree, creating parent directories; returns the absolute path. */
async function put(rel: string, content: string | Uint8Array): Promise<string> {
  const path = join(root, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
}

/** Runs `body` with `paths` locked (mode 000), then unlocks them so afterEach can remove the tree. */
async function withLocked(paths: string[], body: () => Promise<void>): Promise<void> {
  for (const path of paths) await chmod(path, 0o000);
  try {
    await body();
  } finally {
    for (const path of paths) await chmod(path, 0o700);
  }
}

/** The plan in short, in plan order: "name: upload" or "name: skip (reason)". */
function decisions(entries: PlanEntry[]): string[] {
  return entries.map((e) => (e.decision === "upload" ? `${e.name}: upload` : `${e.name}: skip (${e.reason})`));
}

it("lists the top-level files of a directory, skipping dotfiles and subdirectories", async () => {
  await put("case/b.pdf", PDF);
  await put("case/a.docx", DOCX);
  await put("case/notes.MD", "# Σημειώσεις\n");
  await put("case/.DS_Store", "x");
  await put("case/._b.pdf", "AppleDouble"); // the twin macOS leaves beside a file on a foreign volume
  await put("case/sub/inner.pdf", PDF);
  await put("case/.git/HEAD", "ref: refs/heads/main\n");
  await symlink(join(root, "case", "sub"), join(root, "case", "sub-link.pdf")); // leads to a directory
  await symlink(join(root, "case", "missing.pdf"), join(root, "case", "dangling.pdf")); // leads nowhere

  // Named with a trailing separator, as a folder often is. Dotfiles are not rows at all.
  const { entries } = await resolveUploadPlan([join(root, "case") + sep]);

  expect(decisions(entries)).toEqual(["a.docx: upload", "b.pdf: upload", "notes.MD: upload"]);
  expect(entries[0]).toEqual({
    path: join(root, "case", "a.docx"),
    realPath: join(realRoot, "case", "a.docx"),
    name: "a.docx",
    sizeBytes: DOCX.length,
    kind: "docx",
    decision: "upload",
  });
  expect(entries[1]).toMatchObject({ kind: "pdf", sizeBytes: PDF.length });
  expect(entries[2]).toMatchObject({ kind: "text" });
});

it("skips a dotfile named directly (dotfile)", async () => {
  const draft = await put("case/.draft.txt", "not for the matter");

  const { entries } = await resolveUploadPlan([draft]);

  expect(decisions(entries)).toEqual([".draft.txt: skip (dotfile)"]);
});

it("a folder holding only subfolders or dotfiles yields no entries and is listed in emptyPaths", async () => {
  await put("scans/2024/scan-1.pdf", PDF);
  await put("scans/.DS_Store", "x");
  const pleading = await put("case/pleading.pdf", PDF);

  const plan = await resolveUploadPlan([join(root, "scans"), pleading, join(root, "missing.pdf")]);

  expect(decisions(plan.entries)).toEqual(["pleading.pdf: upload", "missing.pdf: skip (not_found)"]);
  expect(plan.emptyPaths).toEqual([join(root, "scans")]);
});

it("leaves a `..` the caller wrote for the OS to resolve after symlinks (listed paths are not joined)", async () => {
  await put("matters/2025/case/pleading.pdf", PDF);
  await mkdir(join(root, "matters", "2025", "archive"));
  await symlink(join(root, "matters", "2025", "archive"), join(root, "latest"));
  // The OS reads latest/.. as matters/2025, so this names matters/2025/case; collapsed as text it
  // would name <root>/case, which does not exist.
  const named = join(root, "latest") + sep + ".." + sep + "case";

  const { entries } = await resolveUploadPlan([named]);

  expect(entries).toEqual([
    {
      path: named + sep + "pleading.pdf",
      realPath: join(realRoot, "matters", "2025", "case", "pleading.pdf"),
      name: "pleading.pdf",
      sizeBytes: PDF.length,
      kind: "pdf",
      decision: "upload",
    },
  ]);
});

it("accepts a directly named file and keeps its name verbatim (Greek, spaces)", async () => {
  const pleading = await put("Υπόθεση Παπαδόπουλου/Αγωγή αρ. 112-2025 τελική.pdf", PDF);
  const notes = await put("Υπόθεση Παπαδόπουλου/a notes.txt", "Σημειώσεις");

  // The caller's order, not name order ("a notes.txt" sorts before "Αγωγή…").
  const { entries } = await resolveUploadPlan([pleading, notes]);

  expect(entries).toEqual([
    {
      path: pleading,
      realPath: join(realRoot, "Υπόθεση Παπαδόπουλου", "Αγωγή αρ. 112-2025 τελική.pdf"),
      name: "Αγωγή αρ. 112-2025 τελική.pdf",
      sizeBytes: PDF.length,
      kind: "pdf",
      decision: "upload",
    },
    {
      path: notes,
      realPath: join(realRoot, "Υπόθεση Παπαδόπουλου", "a notes.txt"),
      name: "a notes.txt",
      sizeBytes: Buffer.byteLength("Σημειώσεις"),
      kind: "text",
      decision: "upload",
    },
  ]);
});

it("refuses a relative path", async () => {
  const { entries } = await resolveUploadPlan(["docs/a.pdf", "~/Documents/a.pdf"]);

  expect(entries).toMatchObject([
    { path: "docs/a.pdf", name: "a.pdf", decision: "skip", reason: "not_absolute" },
    { path: "~/Documents/a.pdf", name: "a.pdf", decision: "skip", reason: "not_absolute" },
  ]);
});

it("skips a path that does not exist (not_found) and one that is neither a file nor a directory (not_a_file)", async () => {
  const file = await put("case/a.pdf", PDF);
  await symlink(join(root, "gone.pdf"), join(root, "dangling.pdf"));
  await symlink(join(root, "loop-b.pdf"), join(root, "loop-a.pdf"));
  await symlink(join(root, "loop-a.pdf"), join(root, "loop-b.pdf"));

  const { entries } = await resolveUploadPlan([
    join(root, "missing.pdf"), // ENOENT
    join(root, "dangling.pdf"), // ENOENT, through a symlink
    join(file, "x.pdf"), // ENOTDIR: a file taken for a folder
    join(root, "loop-a.pdf"), // ELOOP
    "/dev/null",
  ]);

  expect(decisions(entries)).toEqual([
    "missing.pdf: skip (not_found)",
    "dangling.pdf: skip (not_found)",
    "x.pdf: skip (not_found)",
    "loop-a.pdf: skip (not_found)",
    "null: skip (not_a_file)",
  ]);
  expect(entries[0].path).toBe(join(root, "missing.pdf"));
});

it.skipIf(asRoot)("a file or folder the process may not read is `unreadable` (EACCES), while a missing one is `not_found`", async () => {
  const locked = join(root, "locked");
  await put("locked/a.pdf", PDF);
  await put("case/open.pdf", PDF);
  const sealed = await put("case/sealed.pdf", PDF);
  await symlink(join(locked, "a.pdf"), join(root, "case", "linked.pdf"));

  await withLocked([locked, sealed], async () => {
    const { entries } = await resolveUploadPlan([locked, join(locked, "a.pdf"), join(root, "case"), join(root, "missing.pdf")]);

    expect(decisions(entries)).toEqual([
      "locked: skip (unreadable)", // its listing is refused
      "a.pdf: skip (unreadable)", // its folder may not be searched
      "linked.pdf: skip (unreadable)", // a symlink into that folder
      "open.pdf: upload",
      "sealed.pdf: skip (unreadable)", // it may not be opened
      "missing.pdf: skip (not_found)",
    ]);
  });
});

it.skipIf(asRoot)("a .txt the process may not read is skipped as `unreadable`, not planned for upload", async () => {
  const sealed = await put("case/sealed.txt", "Σημειώσεις");

  await withLocked([sealed], async () => {
    const { entries } = await resolveUploadPlan([sealed]);

    expect(decisions(entries)).toEqual(["sealed.txt: skip (unreadable)"]);
  });
});

it("skips a file outside the accept list and a file whose magic bytes contradict its .pdf extension (unsupported_type)", async () => {
  await put("case/brief.doc", "a legacy Word file");
  await put("case/scan.pdf", "not a PDF at all");
  await put("case/memo.docx", PDF); // a PDF under a .docx name: the bytes must match the extension, not merely sniff
  await put("case/Final.PDF", PDF);

  const { entries } = await resolveUploadPlan([join(root, "case")]);

  expect(decisions(entries)).toEqual([
    "Final.PDF: upload",
    "brief.doc: skip (unsupported_type)",
    "memo.docx: skip (unsupported_type)",
    "scan.pdf: skip (unsupported_type)",
  ]);
  expect(entries[0]).toMatchObject({ kind: "pdf" });
});

it("skips a file over MAX_FILE_BYTES (too_large) and an empty file (empty)", async () => {
  // fs.truncate extends a file without writing its bytes (a sparse file), so 50 MB costs nothing.
  await truncate(await put("case/at-limit.pdf", PDF), MAX_FILE_BYTES);
  await truncate(await put("case/over-limit.pdf", PDF), MAX_FILE_BYTES + 1);
  await put("case/empty.txt", "");

  const { entries } = await resolveUploadPlan([join(root, "case")]);

  expect(decisions(entries)).toEqual([
    "at-limit.pdf: upload",
    "empty.txt: skip (empty)",
    "over-limit.pdf: skip (too_large)",
  ]);
  expect(entries.map((e) => e.sizeBytes)).toEqual([MAX_FILE_BYTES, 0, MAX_FILE_BYTES + 1]);
});

it("an empty .pdf is `empty`, not `unsupported_type`", async () => {
  const blank = await put("case/blank.pdf", "");

  const { entries } = await resolveUploadPlan([blank]);

  expect(decisions(entries)).toEqual(["blank.pdf: skip (empty)"]);
});

it("skips a symlink whose real path leaves the named directory (outside_directory) and keeps one that stays inside", async () => {
  // A sibling whose name starts with the folder's: "…/case-archive/" begins with "…/case" but not "…/case/".
  const secret = await put("case-archive/secret.pdf", PDF);
  await put("case/exhibits/exhibit-1.pdf", `${PDF}exhibit`);
  await symlink(secret, join(root, "case", "leak.pdf"));
  await symlink(join("exhibits", "exhibit-1.pdf"), join(root, "case", "exhibit.pdf")); // relative, into a subdirectory
  await symlink(join(root, "case"), join(root, "case-link"));

  const listed = await resolveUploadPlan([join(root, "case")]);
  expect(decisions(listed.entries)).toEqual(["exhibit.pdf: upload", "leak.pdf: skip (outside_directory)"]);
  expect(listed.entries[0]).toEqual({
    path: join(root, "case", "exhibit.pdf"),
    realPath: join(realRoot, "case", "exhibits", "exhibit-1.pdf"),
    name: "exhibit.pdf",
    sizeBytes: `${PDF}exhibit`.length,
    kind: "pdf",
    decision: "upload",
  });

  // Named directly, a file's directory is the one it sits in.
  const direct = await resolveUploadPlan([join(root, "case", "leak.pdf")]);
  expect(decisions(direct.entries)).toEqual(["leak.pdf: skip (outside_directory)"]);

  // The named directory may itself be a symlink: containment is judged against where it leads.
  const viaLink = await resolveUploadPlan([join(root, "case-link")]);
  expect(decisions(viaLink.entries)).toEqual(["exhibit.pdf: upload", "leak.pdf: skip (outside_directory)"]);
});

it("deduplicates by real path when a file is named directly and through its directory (duplicate_path)", async () => {
  await put("case/a.pdf", PDF);
  const b = await put("case/b.pdf", PDF);
  await symlink(b, join(root, "case", "c-alias.pdf")); // b.pdf under another name

  const { entries } = await resolveUploadPlan([b, join(root, "case")]);

  expect(decisions(entries)).toEqual([
    "b.pdf: upload",
    "a.pdf: upload",
    "b.pdf: skip (duplicate_path)",
    "c-alias.pdf: skip (duplicate_path)",
  ]);
});

it("caps the upload list at MAX_FILES_PER_CALL (too_many_files)", async () => {
  const name = (i: number) => `f${String(i).padStart(3, "0")}.txt`;
  for (let i = 0; i <= MAX_FILES_PER_CALL; i++) await put(join("case", name(i)), `file ${i}`);
  await put("case/.hidden.txt", "x");
  await put("case/brief.doc", "x");

  // f000 on its own first, then again through the folder. The dotfile (omitted), the .doc (skipped)
  // and the duplicate all sort before the cap and take no slot, so the last file of the folder is left over.
  const { entries } = await resolveUploadPlan([join(root, "case", name(0)), join(root, "case")]);

  expect(entries.filter((e) => e.decision === "upload")).toHaveLength(MAX_FILES_PER_CALL);
  expect(decisions(entries.filter((e) => e.decision === "skip"))).toEqual([
    "brief.doc: skip (unsupported_type)",
    "f000.txt: skip (duplicate_path)",
    `${name(MAX_FILES_PER_CALL)}: skip (too_many_files)`,
  ]);
});

it("digest changes when a planned file's size changes and ignores skipped entries", async () => {
  await put("case/a.pdf", PDF);
  const notes = await put("case/b.txt", "notes");
  const first = await resolveUploadPlan([join(root, "case")]);
  expect(first.digest).toMatch(/^[0-9a-f]{16}$/);
  expect(first.digest).toBe(planDigest(first.entries));

  await put("case/.b.txt", "hidden");
  await put("case/c.doc", "legacy");
  await put("case/d.md", "");
  const withSkips = await resolveUploadPlan([join(root, "case")]);
  expect(decisions(withSkips.entries)).toEqual([
    "a.pdf: upload",
    "b.txt: upload",
    "c.doc: skip (unsupported_type)",
    "d.md: skip (empty)",
  ]);
  expect(withSkips.digest).toBe(first.digest);

  await appendFile(notes, ", amended");
  expect((await resolveUploadPlan([join(root, "case")])).digest).not.toBe(first.digest);
});

it("digest depends on which files are planned, not on the order they were named in", async () => {
  const a = await put("case/a.pdf", PDF);
  const b = await put("case/b.txt", "notes");
  const forward = await resolveUploadPlan([a, b]);
  expect((await resolveUploadPlan([b, a])).digest).toBe(forward.digest);

  const c = join(root, "case", "c.txt");
  await rename(b, c); // the same bytes under another path
  expect((await resolveUploadPlan([a, c])).digest).not.toBe(forward.digest);
});
