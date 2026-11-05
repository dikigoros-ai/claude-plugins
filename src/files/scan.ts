// The scan behind `scan_project`: a project folder walked recursively, every file it holds with the
// 0.1.0 candidate checks (eligible, or the reason it is not), and the folders with their counts. The
// walk is capped in depth and in entries looked at, and never leaves the folder's real path through a
// symlink. It reads the filesystem and changes nothing.

import { type Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, parse, sep } from "node:path";
import { type FileKind, resolveCandidate, type SkipReason } from "./resolve";

/** The deepest a file is looked at: the root's direct children are at depth 1. */
export const SCAN_MAX_DEPTH = 8;
/** The most files and folders one scan looks at. */
export const SCAN_MAX_ENTRIES = 5000;
/** Folder names never entered, besides any name starting with "." */
export const SCAN_SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", "__MACOSX"]);

/** Why a scanned file is not offered: a 0.1.0 skip reason, or a file the link file records as uploaded. */
export type ScanReason = SkipReason | "already_uploaded";

/** One file of the scan. */
export interface ScannedFile {
  /** From the root, "/"-separated on every platform, e.g. "Pleadings/Αγωγή.pdf". */
  relativePath: string;
  /** Absolute, as reached: the root as given followed by the relative path, with the platform's separator. */
  path: string;
  /** Where `path` really leads, symlinks resolved; "" when it could not be read. */
  realPath: string;
  /** The basename, verbatim (Greek letters, spaces). */
  name: string;
  /** From `stat`, so a symlink's target; 0 when it could not be read. */
  sizeBytes: number;
  /** From the same `stat`; 0 when it could not be read. */
  mtimeMs: number;
  /** What the accepted extension stands for; null for any other name and for magic bytes that contradict it. */
  kind: FileKind | null;
  eligible: boolean;
  /** Present exactly when `eligible` is false. */
  reason?: ScanReason;
}

/** One folder the walk entered, with the counts of the files directly in it. */
export interface ScannedFolder {
  /** "/"-separated from the root; "" for the root. */
  relativePath: string;
  /** 0 for the root, 1 for its direct subfolders. */
  depth: number;
  /** The files directly in this folder that the scan lists. */
  files: number;
  /** Of those, the eligible ones. */
  eligible: number;
}

/** A whole scan. */
export interface ProjectScan {
  /** The root as given. */
  root: string;
  /** Its real path, symlinks resolved. */
  realRoot: string;
  /** Sorted by relativePath (folder order, then name), stable across runs. */
  files: ScannedFile[];
  /** Sorted the same way, the root first. */
  folders: ScannedFolder[];
  /** Which cap left part of the tree unseen; null when the whole tree was looked at. */
  truncated: null | "depth" | "entries";
}

/** A root the scan refuses before walking anything. */
export class ScanRootError extends Error {
  constructor(
    readonly reason: "not_absolute" | "home_directory" | "filesystem_root" | "not_a_directory" | "not_found" | "unreadable",
  ) {
    super(`The folder cannot be scanned: ${reason}.`);
    this.name = "ScanRootError";
  }
}

/** A folder the walk will enter. */
interface Folder {
  /** As reached, with the platform's separator. */
  path: string;
  realPath: string;
  /** "/"-separated from the root. */
  relativePath: string;
  depth: number;
}

/**
 * Scans `root`, which must be an absolute path to a directory that is neither the filesystem root nor
 * `opts.homeDir` itself (each compared by real path). The walk goes breadth-first, each folder's
 * children by name, and skips without an entry: names starting with "." (`.dikigoros` among them),
 * Office lock files (names starting with "~$"), folders named in SCAN_SKIP_DIRS, symlinks that lead
 * nowhere and folders it may not list. A symlinked folder is entered only when its real path is inside
 * the root's real path and no folder with that real path was entered already; symlinked folders wait
 * until the real folders are walked, so a real folder keeps its own path rather than a link's. Every
 * file gets the 0.1.0 candidate checks against the root's real path, so a symlinked file that leads
 * out of the root is `outside_directory`. A file deeper than SCAN_MAX_DEPTH is not looked at and the
 * scan is truncated "depth"; once SCAN_MAX_ENTRIES files and folders are looked at, the walk stops and
 * the scan is truncated "entries".
 */
export async function scanProject(root: string, opts: { homeDir: string }): Promise<ProjectScan> {
  const realRoot = await checkRoot(root, opts.homeDir);
  const walk = new Walk(realRoot);
  await walk.run({ path: root, realPath: realRoot, relativePath: "", depth: 0 });
  return {
    root,
    realRoot,
    files: walk.files.sort(compareFiles),
    folders: walk.folders.sort(compareFolders),
    truncated: walk.truncated,
  };
}

/** The root's real path, or the ScanRootError that refuses it. */
async function checkRoot(root: string, homeDir: string): Promise<string> {
  if (!isAbsolute(root)) throw new ScanRootError("not_absolute");
  const realRoot = await realpath(root).catch((err: unknown) => {
    throw new ScanRootError(fsReason(err));
  });
  if (parse(realRoot).root === realRoot) throw new ScanRootError("filesystem_root");
  const realHome = await realpath(homeDir).catch(() => homeDir);
  // The home directory, or a folder holding it (/Users, /home): far more than one project.
  const homeInside = realHome.endsWith(sep) ? realHome : realHome + sep;
  if (realRoot === realHome || homeInside.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) {
    throw new ScanRootError("home_directory");
  }
  const stats = await stat(realRoot).catch((err: unknown) => {
    throw new ScanRootError(fsReason(err));
  });
  if (!stats.isDirectory()) throw new ScanRootError("not_a_directory");
  await readdir(realRoot).catch((err: unknown) => {
    throw new ScanRootError(fsReason(err));
  });
  return realRoot;
}

/** The walk as it goes: what it found, what it has entered, and how much it has looked at. */
class Walk {
  readonly files: ScannedFile[] = [];
  readonly folders: ScannedFolder[] = [];
  truncated: ProjectScan["truncated"] = null;
  /** The root's real path ending in a separator: every real path the walk follows starts with it. */
  readonly #inside: string;
  /** Real paths of the folders entered or queued to be. */
  readonly #visited = new Set<string>();
  /** Real folders to enter, in order. */
  readonly #queue: Folder[] = [];
  /** Symlinked folders inside the root, entered once the real folders are walked. */
  readonly #linked: Folder[] = [];
  #looked = 0;

  constructor(realRoot: string) {
    this.#inside = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  }

  /** Walks from `root` until the tree is done or the entry cap stops it. */
  async run(root: Folder): Promise<void> {
    this.#visited.add(root.realPath);
    this.#queue.push(root);
    for (;;) {
      const next = this.#queue.shift() ?? this.#nextLinked();
      if (next === undefined || this.truncated === "entries") return;
      await this.#enter(next);
    }
  }

  /** The next symlinked folder no folder with its real path was entered for, marked visited. */
  #nextLinked(): Folder | undefined {
    for (let folder = this.#linked.shift(); folder !== undefined; folder = this.#linked.shift()) {
      if (!this.#visited.has(folder.realPath)) {
        this.#visited.add(folder.realPath);
        return folder;
      }
    }
    return undefined;
  }

  /** Lists `folder` and looks at each child the name rules let through; a folder it may not list adds nothing. */
  async #enter(folder: Folder): Promise<void> {
    const children = await readdir(folder.realPath, { withFileTypes: true }).catch(() => null);
    if (children === null) return;
    const record: ScannedFolder = { relativePath: folder.relativePath, depth: folder.depth, files: 0, eligible: 0 };
    this.folders.push(record);
    for (const child of children.filter(walked).sort(byName)) {
      if (this.#looked >= SCAN_MAX_ENTRIES) {
        this.truncated = "entries";
        return;
      }
      this.#looked++;
      const reached: Folder = {
        path: (folder.path.endsWith(sep) ? folder.path : folder.path + sep) + child.name,
        realPath: folder.realPath + sep + child.name,
        relativePath: folder.relativePath === "" ? child.name : `${folder.relativePath}/${child.name}`,
        depth: folder.depth + 1,
      };
      const file = await this.#lookAt(child, reached);
      if (file !== null) {
        this.files.push(file);
        record.files++;
        if (file.eligible) record.eligible++;
      }
    }
  }

  /** One child `walked` let through: a folder is queued (or found past the depth cap), a file becomes
   *  its entry; null for no entry. */
  async #lookAt(child: Dirent, reached: Folder): Promise<ScannedFile | null> {
    if (child.isDirectory()) {
      await this.#queueFolder(reached, false);
      return null;
    }
    const stats = await stat(reached.realPath).catch((err: unknown) => fsReason(err));
    if (stats === "not_found") return null; // a symlink that leads nowhere
    if (stats === "unreadable") return unreadable(reached);
    if (stats.isDirectory()) {
      const realPath = await realpath(reached.realPath).catch(() => null);
      if (realPath !== null && realPath.startsWith(this.#inside)) await this.#queueFolder({ ...reached, realPath }, true);
      return null;
    }
    if (!stats.isFile()) return null;
    const entry = await resolveCandidate(reached.path, stats.size, this.#inside);
    const file: ScannedFile = {
      relativePath: reached.relativePath,
      path: entry.path,
      realPath: entry.realPath,
      name: entry.name,
      sizeBytes: entry.sizeBytes,
      mtimeMs: stats.mtimeMs,
      kind: entry.kind,
      eligible: entry.decision === "upload",
    };
    if (entry.reason !== undefined) file.reason = entry.reason;
    return file;
  }

  /** Queues a folder the walk reached, or, at the depth cap, marks the scan truncated when the folder
   *  holds anything the walk would have looked at. */
  async #queueFolder(folder: Folder, linked: boolean): Promise<void> {
    if (folder.depth >= SCAN_MAX_DEPTH) {
      const children = await readdir(folder.realPath, { withFileTypes: true }).catch(() => []);
      if (children.some(walked) && this.truncated === null) this.truncated = "depth";
      return;
    }
    if (linked) {
      this.#linked.push(folder);
    } else if (!this.#visited.has(folder.realPath)) {
      this.#visited.add(folder.realPath);
      this.#queue.push(folder);
    }
  }
}

/** Whether the walk looks at a child at all: not hidden, not an Office lock file, not a skipped folder
 *  name (unless it is a plain file), and a file, folder or symlink. */
function walked(child: Dirent): boolean {
  if (child.name.startsWith(".") || child.name.startsWith("~$")) return false;
  if (SCAN_SKIP_DIRS.has(child.name) && !child.isFile()) return false;
  return child.isFile() || child.isDirectory() || child.isSymbolicLink();
}

/** Orders a folder's children by name, by UTF-16 code unit as Array.prototype.sort does. */
function byName(a: Dirent, b: Dirent): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Orders files by the folder they are in, then by name (so a folder's own files come before its
 *  subfolders'), each part by UTF-16 code unit. */
function compareFiles(a: ScannedFile, b: ScannedFile): number {
  const pa = a.relativePath.split("/");
  const pb = b.relativePath.split("/");
  return compareSegments(pa.slice(0, -1), pb.slice(0, -1)) || compareSegments(pa.slice(-1), pb.slice(-1));
}

/** Orders folders by relative path, segment by segment, so a folder comes right before its subfolders. */
function compareFolders(a: ScannedFolder, b: ScannedFolder): number {
  const segments = (relativePath: string) => (relativePath === "" ? [] : relativePath.split("/"));
  return compareSegments(segments(a.relativePath), segments(b.relativePath));
}

/** Compares two segment lists one segment at a time by UTF-16 code unit; a list before its own extensions. */
function compareSegments(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

/** A failed filesystem call as a reason: it leads nowhere (ENOENT, ENOTDIR, ELOOP), or it is there but
 *  may not be read (EACCES, EPERM and any other code), as resolve.ts decides it. */
function fsReason(err: unknown): "not_found" | "unreadable" {
  const code = err instanceof Error && "code" in err ? err.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" ? "not_found" : "unreadable";
}

/** The entry of a file the listing names but that may not be read. */
function unreadable(reached: Folder): ScannedFile {
  const name = reached.relativePath.split("/").at(-1) ?? "";
  return {
    relativePath: reached.relativePath,
    path: reached.path,
    realPath: "",
    name,
    sizeBytes: 0,
    mtimeMs: 0,
    kind: null,
    eligible: false,
    reason: "unreadable",
  };
}
