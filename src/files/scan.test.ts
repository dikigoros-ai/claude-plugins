import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse, sep } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MAX_FILE_BYTES } from "./resolve";
import { type ProjectScan, SCAN_MAX_DEPTH, SCAN_MAX_ENTRIES, ScanRootError, scanProject } from "./scan";

const PDF = "%PDF-1.7\n%test\n";
const DOCX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]); // the ZIP header every .docx starts with

// Root reads through any permission bits, so a chmod 000 lock does not hold for it.
const asRoot = process.getuid?.() === 0;

// Each test builds its own tree under `base`. `root` is the project folder as a caller names it;
// `realRoot` is where it really is (on macOS os.tmpdir() sits behind /var -> /private/var). `outside`
// is a sibling folder that is not part of the project, for symlinks that escape it.
let base: string;
let root: string;
let realRoot: string;
let outside: string;
// A home directory that is none of the folders under test.
let homeDir: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "dikigoros-scan-"));
  root = join(base, "project");
  outside = join(base, "outside");
  homeDir = join(base, "home");
  await mkdir(root);
  await mkdir(outside);
  await mkdir(homeDir);
  realRoot = await realpath(root);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Writes `content` at `rel` under the project, creating parent folders; returns the absolute path. */
async function put(rel: string, content: string | Uint8Array): Promise<string> {
  const path = join(root, ...rel.split("/"));
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

const scan = (): Promise<ProjectScan> => scanProject(root, { homeDir });

/** The scan in short, in scan order: "relativePath" for an eligible file, "relativePath (reason)" otherwise. */
function rows(result: ProjectScan): string[] {
  return result.files.map((f) => (f.eligible ? f.relativePath : `${f.relativePath} (${f.reason})`));
}

/** The ScanRootError reason `promise` rejects with. */
async function rootError(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ScanRootError);
  return (err as ScanRootError).reason;
}

it("walks subfolders and gives POSIX relative paths, sorted", async () => {
  await put("z.pdf", PDF);
  await put("a.docx", DOCX);
  await put("B/d.pdf", PDF);
  await put("A/Sub/c.txt", "notes");
  await put("A/b.md", "# notes");
  await put("A-old/e.pdf", PDF);

  const result = await scan();

  expect(result.root).toBe(root);
  expect(result.realRoot).toBe(realRoot);
  expect(result.truncated).toBeNull();
  expect(rows(result)).toEqual(["a.docx", "z.pdf", "A/b.md", "A/Sub/c.txt", "A-old/e.pdf", "B/d.pdf"]);
  const sub = result.files.find((f) => f.relativePath === "A/Sub/c.txt");
  const stats = await stat(join(root, "A", "Sub", "c.txt"));
  expect(sub).toEqual({
    relativePath: "A/Sub/c.txt",
    path: join(root, "A", "Sub", "c.txt"),
    realPath: join(realRoot, "A", "Sub", "c.txt"),
    name: "c.txt",
    sizeBytes: 5,
    mtimeMs: stats.mtimeMs,
    kind: "text",
    eligible: true,
  });
  expect(result.folders.map((f) => [f.relativePath, f.depth])).toEqual([
    ["", 0],
    ["A", 1],
    ["A/Sub", 2],
    ["A-old", 1],
    ["B", 1],
  ]);

  // Stable across runs.
  expect(await scan()).toEqual(result);
});

it("keeps Greek and spaced names verbatim in name and relativePath", async () => {
  await put("Δικόγραφα/Αγωγή κατά Παπαδόπουλου.pdf", PDF);
  await put("Old Files/Σημειώσεις 2026.md", "# Σημειώσεις\n");

  const result = await scan();

  expect(rows(result)).toEqual(["Old Files/Σημειώσεις 2026.md", "Δικόγραφα/Αγωγή κατά Παπαδόπουλου.pdf"]);
  expect(result.files.map((f) => f.name)).toEqual(["Σημειώσεις 2026.md", "Αγωγή κατά Παπαδόπουλου.pdf"]);
  expect(result.files[1].path).toBe(join(root, "Δικόγραφα", "Αγωγή κατά Παπαδόπουλου.pdf"));
});

it("skips hidden files and folders, node_modules, __MACOSX, .dikigoros and Office lock files (~$x.docx)", async () => {
  await put("brief.pdf", PDF);
  await put(".DS_Store", "x");
  await put("._brief.pdf", "AppleDouble");
  await put(".git/HEAD", "ref: refs/heads/main\n");
  await put(".dikigoros/matter.json", "{}");
  await put(".hidden/inside.pdf", PDF);
  await put("node_modules/pkg/readme.md", "# pkg");
  await put("__MACOSX/Pleadings/._x.pdf", "AppleDouble");
  await put("~$brief.docx", "lock");
  await put("Pleadings/~$Αγωγή.docx", "lock");
  await put("Pleadings/Αγωγή.docx", DOCX);

  const result = await scan();

  expect(rows(result)).toEqual(["brief.pdf", "Pleadings/Αγωγή.docx"]);
  expect(result.folders.map((f) => f.relativePath)).toEqual(["", "Pleadings"]);
});

it("marks each ineligible file with the 0.1.0 reason: unsupported_type, empty, too_large", async () => {
  await put("photo.jpg", "jpeg");
  await put("fake.pdf", "not a pdf at all"); // the magic bytes contradict the extension
  await put("blank.docx", "");
  const big = await put("huge.pdf", PDF);
  await truncate(big, MAX_FILE_BYTES + 1); // sparse: no 50 MB written

  const result = await scan();

  expect(rows(result)).toEqual(["blank.docx (empty)", "fake.pdf (unsupported_type)", "huge.pdf (too_large)", "photo.jpg (unsupported_type)"]);
  expect(result.files.find((f) => f.name === "photo.jpg")).toMatchObject({ kind: null, eligible: false });
  expect(result.files.find((f) => f.name === "blank.docx")).toMatchObject({ kind: "docx", sizeBytes: 0 });
  expect(result.files.find((f) => f.name === "huge.pdf")).toMatchObject({ kind: "pdf", sizeBytes: MAX_FILE_BYTES + 1 });
  for (const file of result.files) expect("reason" in file).toBe(!file.eligible);
});

it.skipIf(asRoot)("marks a file it may not read unreadable, and adds nothing for a folder it may not read, without throwing", async () => {
  const sealed = await put("sealed.pdf", PDF);
  await put("open.pdf", PDF);
  await put("Locked/inner.pdf", PDF);

  await withLocked([sealed, join(root, "Locked")], async () => {
    const result = await scan();

    expect(rows(result)).toEqual(["open.pdf", "sealed.pdf (unreadable)"]);
    expect(result.files[1]).toMatchObject({ kind: "pdf", eligible: false, reason: "unreadable" });
    expect(result.folders.map((f) => f.relativePath)).toEqual([""]);
  });
});

it("refuses a relative root, the home directory, a filesystem root and a file as root (ScanRootError)", async () => {
  const file = await put("brief.pdf", PDF);

  expect(await rootError(scanProject("project", { homeDir }))).toBe("not_absolute");
  expect(await rootError(scanProject(homeDir, { homeDir }))).toBe("home_directory");
  // The home directory named through a symlink, and with a trailing separator, is still the home directory.
  await symlink(homeDir, join(base, "home-link"));
  expect(await rootError(scanProject(join(base, "home-link") + sep, { homeDir }))).toBe("home_directory");
  // A folder that holds the home directory (/Users, /home) is refused the same way.
  expect(await rootError(scanProject(dirname(homeDir), { homeDir }))).toBe("home_directory");
  expect(await rootError(scanProject(parse(realRoot).root, { homeDir }))).toBe("filesystem_root");
  expect(await rootError(scanProject(file, { homeDir }))).toBe("not_a_directory");
  expect(await rootError(scanProject(join(root, "missing"), { homeDir }))).toBe("not_found");
});

it("follows a symlinked folder that stays inside the root and never enters one that escapes it", async () => {
  await put("Archive/2025/old.pdf", PDF);
  await symlink(join(root, "Archive", "2025"), join(root, "Current"));
  await writeFile(join(outside, "secret.pdf"), PDF);
  await symlink(outside, join(root, "Elsewhere"));

  const result = await scan();

  // The real folder keeps its own path; the link to it adds no second copy.
  expect(rows(result)).toEqual(["Archive/2025/old.pdf"]);
  expect(result.folders.map((f) => f.relativePath)).toEqual(["", "Archive", "Archive/2025"]);

  // A link into a folder the walk skips is the only way in, so it is entered under its own name.
  await put(".store/kept.pdf", PDF);
  await symlink(join(root, ".store"), join(root, "Store"));
  const again = await scan();
  expect(rows(again)).toEqual(["Archive/2025/old.pdf", "Store/kept.pdf"]);
  expect(again.files[1]).toMatchObject({ path: join(root, "Store", "kept.pdf"), realPath: join(realRoot, ".store", "kept.pdf") });
  expect(again.files.some((f) => f.name === "secret.pdf")).toBe(false);
});

it("marks a symlinked file that escapes the root outside_directory", async () => {
  await writeFile(join(outside, "secret.pdf"), PDF);
  await symlink(join(outside, "secret.pdf"), join(root, "secret.pdf"));
  await put("brief.pdf", PDF);
  await symlink(join(root, "brief.pdf"), join(root, "brief-link.pdf")); // stays inside
  await symlink(join(root, "missing.pdf"), join(root, "dangling.pdf")); // leads nowhere: no entry

  const result = await scan();

  expect(rows(result)).toEqual(["brief-link.pdf", "brief.pdf", "secret.pdf (outside_directory)"]);
  expect(result.files[2].realPath).toBe(join(await realpath(outside), "secret.pdf"));
});

it("enters a symlink cycle once", async () => {
  await put("A/a.pdf", PDF);
  await put("A/B/b.pdf", PDF);
  await symlink(join(root, "A"), join(root, "A", "B", "back-to-A")); // A/B/back-to-A -> A
  await symlink(root, join(root, "A", "up")); // A/up -> the root itself
  await symlink(join(root, "A", "B"), join(root, "A", "B", "self")); // A/B/self -> A/B

  const result = await scan();

  expect(rows(result)).toEqual(["A/a.pdf", "A/B/b.pdf"]);
  expect(result.folders.map((f) => f.relativePath)).toEqual(["", "A", "A/B"]);
  expect(result.truncated).toBeNull();
});

it("stops at depth 8 with truncated: 'depth' and at 5,000 entries with truncated: 'entries'", async () => {
  // d1/…/d7/g.pdf is a file at depth 8; d1/…/d8/f.pdf one at depth 9.
  const folders = Array.from({ length: SCAN_MAX_DEPTH }, (_, i) => `d${i + 1}`);
  await put([...folders.slice(0, SCAN_MAX_DEPTH - 1), "g.pdf"].join("/"), PDF);
  const deep = await put([...folders, "f.pdf"].join("/"), PDF);

  const capped = await scan();
  expect(rows(capped)).toEqual([[...folders.slice(0, SCAN_MAX_DEPTH - 1), "g.pdf"].join("/")]);
  expect(capped.truncated).toBe("depth");
  expect(Math.max(...capped.folders.map((f) => f.depth))).toBe(SCAN_MAX_DEPTH - 1);

  // An empty folder at depth 8 hides nothing.
  await rm(deep);
  expect((await scan()).truncated).toBeNull();
  await rm(join(root, "d1"), { recursive: true });

  // 5,000 files and one folder: the folder is the 5,001st entry looked at.
  const names = Array.from({ length: SCAN_MAX_ENTRIES }, (_, i) => `f${String(i).padStart(4, "0")}.pdf`);
  for (let i = 0; i < names.length; i += 500) {
    await Promise.all(names.slice(i, i + 500).map((name) => writeFile(join(root, name), "")));
  }
  await put("zz/late.pdf", PDF);

  const full = await scan();
  expect(full.truncated).toBe("entries");
  expect(full.files).toHaveLength(SCAN_MAX_ENTRIES);
  expect(full.files.every((f) => f.reason === "empty")).toBe(true);
  expect(full.folders.map((f) => f.relativePath)).toEqual([""]);

  // Exactly 5,000 entries leaves nothing out.
  await rm(join(root, "zz"), { recursive: true });
  const exact = await scan();
  expect(exact.truncated).toBeNull();
  expect(exact.files).toHaveLength(SCAN_MAX_ENTRIES);
}, 30_000);

it("counts files and eligible files per folder", async () => {
  await put("top.pdf", PDF);
  await put("photo.jpg", "jpeg");
  await put("Pleadings/a.pdf", PDF);
  await put("Pleadings/b.docx", DOCX);
  await put("Pleadings/empty.txt", "");
  await put("Pleadings/Old/c.pdf", PDF);
  await put("Pleadings/.hidden.pdf", PDF); // skipped: not counted
  await mkdir(join(root, "Empty"));

  const result = await scan();

  expect(result.folders).toEqual([
    { relativePath: "", depth: 0, files: 2, eligible: 1 },
    { relativePath: "Empty", depth: 1, files: 0, eligible: 0 },
    { relativePath: "Pleadings", depth: 1, files: 3, eligible: 2 },
    { relativePath: "Pleadings/Old", depth: 2, files: 1, eligible: 1 },
  ]);
});

it("reads the filesystem only: the tree is byte-identical after a scan", async () => {
  await put("brief.pdf", PDF);
  await put("Pleadings/Αγωγή.docx", DOCX);
  await put("Pleadings/notes.md", "# notes");
  await put(".dikigoros/matter.json", "{}");
  await symlink(join(root, "Pleadings"), join(root, "Link"));

  /** Every entry under the project with its type, size, mtime and (for a file) its bytes. */
  async function snapshot(): Promise<string[]> {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    const out: string[] = [];
    for (const entry of entries) {
      const path = join(entry.parentPath, entry.name);
      const stats = await stat(path);
      const bytes = entry.isFile() ? (await readFile(path)).toString("base64") : "";
      out.push(`${path} ${entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "dir" : "file"} ${stats.size} ${stats.mtimeMs} ${bytes}`);
    }
    return out.sort();
  }

  const before = await snapshot();
  await scan();
  expect(await snapshot()).toEqual(before);
});
