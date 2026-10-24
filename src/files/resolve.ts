// The upload plan behind `upload_to_matter`: the absolute paths the model passes, resolved to the
// files that would be uploaded and the ones that would not (each with its reason), plus a digest of
// the uploads that the confirm call compares, so a folder that changed in between is listed again.
// It reads the filesystem and changes nothing.

import { createHash } from "node:crypto";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, sep } from "node:path";
import { sniffFileKind } from "../extract/sniff";

// Ported from dikigoros-ai/dikigoros-ai lib/matters.ts @ 37f39ac5 (2026-10-19): the one accept list
// and the per-file size cap of the web uploader and the documents route.
export const MATTER_UPLOAD_ACCEPT = ".pdf,.docx,.txt,.md";
export const MATTER_UPLOAD_EXT_RE = /\.(pdf|docx|txt|md)$/i;
export const TEXT_DOCUMENT_EXT_RE = /\.(txt|md)$/i;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** The helper's own limits per `upload_to_matter` call. */
export const MAX_PATHS_PER_CALL = 50;
export const MAX_FILES_PER_CALL = 100;

export type FileKind = "pdf" | "docx" | "text";
export type SkipReason =
  | "not_absolute"
  | "not_found"
  | "unreadable"
  | "not_a_file"
  | "dotfile"
  | "unsupported_type"
  | "too_large"
  | "empty"
  | "outside_directory"
  | "duplicate_path"
  | "too_many_files";

export interface PlanEntry {
  /** The path as given; for a file listed from a directory, that directory as given followed by its name. */
  path: string;
  /** Where `path` really leads, symlinks resolved; "" when it never resolved, or was capped unseen. */
  realPath: string;
  /** The basename of `path`, verbatim (Greek letters, spaces): the document's filename. */
  name: string;
  /** From `stat`, so a symlink's target; 0 when the path never resolved, or was capped unseen. */
  sizeBytes: number;
  /** What the accepted extension stands for; null for entries skipped before the extension check
   *  and for magic bytes that contradict it. */
  kind: FileKind | null;
  decision: "upload" | "skip";
  /** Present exactly when `decision` is "skip". */
  reason?: SkipReason;
}

export interface UploadPlan {
  entries: PlanEntry[];
  digest: string;
  /** Named paths that produced no entry at all, e.g. a folder holding only subfolders or dotfiles. */
  emptyPaths: string[];
}

/**
 * The plan for `paths`, in the caller's order. Only absolute paths are taken: the server's working
 * directory is unknown, so nothing is resolved against it. A file stands for itself; a directory for
 * its direct children that are files or symlinks to files, by name, dotfiles omitted (subdirectories
 * are not entered). A path that leads nowhere is not_found; one that is there but may not be read
 * (EACCES, EPERM: macOS privacy protection, for one) is unreadable. Every candidate then gets the
 * reason of the first check it fails: its real path stays inside the directory that was named (for a
 * named file, the one it sits in); not a dotfile; an accepted extension; not empty; at most
 * MAX_FILE_BYTES; its first bytes can be read and, for PDF/DOCX, agree with the extension; not
 * planned already. Once MAX_FILES_PER_CALL files are planned, every further candidate is
 * too_many_files without being looked at (no stat, realpath or open; a named path is still told
 * apart as a file or a folder, and a folder still listed), so a folder of thousands of files costs
 * one listing. A named path that yields no entry is in `emptyPaths`.
 */
export async function resolveUploadPlan(paths: string[]): Promise<UploadPlan> {
  const plan = new PlanBuilder();
  for (const path of paths) {
    const before = plan.entries.length;
    await resolvePath(path, plan);
    if (plan.entries.length === before) plan.emptyPaths.push(path);
  }
  return { entries: plan.entries, digest: planDigest(plan.entries), emptyPaths: plan.emptyPaths };
}

/** The plan as it is built: the entries in order, and the real paths of the files it uploads. */
class PlanBuilder {
  readonly entries: PlanEntry[] = [];
  readonly emptyPaths: string[] = [];
  readonly #uploads = new Set<string>();

  /** Whether MAX_FILES_PER_CALL files are planned: a candidate from now on is capped unseen. */
  get full(): boolean {
    return this.#uploads.size >= MAX_FILES_PER_CALL;
  }

  /** Adds `entry`; an upload of a real path the plan uploads already is a duplicate_path skip instead. */
  add(entry: PlanEntry): void {
    if (entry.decision === "upload") {
      if (this.#uploads.has(entry.realPath)) {
        this.entries.push({ ...entry, decision: "skip", reason: "duplicate_path" });
        return;
      }
      this.#uploads.add(entry.realPath);
    }
    this.entries.push(entry);
  }
}

/** sha256 over the sorted "realPath\0sizeBytes" of the upload entries, first 16 hex characters. */
export function planDigest(entries: PlanEntry[]): string {
  const uploads = entries.filter((e) => e.decision === "upload").map((e) => `${e.realPath}\0${e.sizeBytes}`);
  return createHash("sha256").update(uploads.sort().join("\n")).digest("hex").slice(0, 16);
}

/** A filesystem call that failed, as the reason its path is skipped: the path leads nowhere (ENOENT,
 *  ENOTDIR, ELOOP), or it is there but may not be read (EACCES, EPERM and any other code). */
class FsFailure {
  readonly reason: "not_found" | "unreadable";

  constructor(err: unknown) {
    const code = err instanceof Error && "code" in err ? err.code : undefined;
    this.reason = code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" ? "not_found" : "unreadable";
  }
}

const failure = (err: unknown) => new FsFailure(err);

/** One path as given: the entries of its candidate files, or one entry saying why it has none. */
async function resolvePath(path: string, plan: PlanBuilder): Promise<void> {
  if (!isAbsolute(path)) return plan.add(unresolved(path, "not_absolute"));
  const stats = await stat(path).catch(failure);
  if (stats instanceof FsFailure) return plan.add(unresolved(path, stats.reason));
  if (stats.isDirectory()) return resolveDirectory(path, plan);
  if (!stats.isFile()) return plan.add(unresolved(path, "not_a_file"));
  if (plan.full) return plan.add(unresolved(path, "too_many_files"));
  // A named file is contained by the directory it sits in.
  const inside = await realpath(dirname(path)).then(withTrailingSep, failure);
  if (inside instanceof FsFailure) return plan.add(unresolved(path, inside.reason));
  plan.add(await resolveCandidate(path, stats.size, inside));
}

/** A named directory's direct children that are files or symlinks to files, sorted by name so the plan
 *  (and which files the cap leaves out) does not follow the filesystem's listing order. Dotfiles,
 *  subdirectories and symlinks that lead to a directory or nowhere are omitted without an entry; past
 *  the cap every file or symlink the listing names is capped unseen. */
async function resolveDirectory(directory: string, plan: PlanBuilder): Promise<void> {
  // The real path its files must stay inside; not read when no file of it will be looked at.
  const inside = plan.full ? null : await realpath(directory).then(withTrailingSep, failure);
  if (inside instanceof FsFailure) return plan.add(unresolved(directory, inside.reason));
  const children = await readdir(directory, { withFileTypes: true }).catch(failure);
  if (children instanceof FsFailure) return plan.add(unresolved(directory, children.reason));
  const names = children
    .filter((child) => (child.isFile() || child.isSymbolicLink()) && !child.name.startsWith("."))
    .map((child) => child.name)
    .sort();
  for (const name of names) {
    // Concatenated, not path.join: join would collapse a ".." the caller wrote as text, while the OS
    // resolves it after the symlinks before it.
    const path = withTrailingSep(directory) + name;
    if (inside === null || plan.full) {
      plan.add(unresolved(path, "too_many_files"));
      continue;
    }
    const stats = await stat(path).catch(failure);
    if (stats instanceof FsFailure) {
      if (stats.reason === "unreadable") plan.add(unresolved(path, "unreadable"));
    } else if (stats.isFile()) {
      plan.add(await resolveCandidate(path, stats.size, inside));
    }
  }
}

/** One candidate file; the first check it fails decides its reason. `inside` is the real path of the
 *  directory that was named, ending in a separator. */
async function resolveCandidate(path: string, sizeBytes: number, inside: string): Promise<PlanEntry> {
  const realPath = await realpath(path).catch(failure);
  if (realPath instanceof FsFailure) return unresolved(path, realPath.reason);
  const name = basename(path);
  const skip = (reason: SkipReason, kind: FileKind | null = null): PlanEntry => ({
    path,
    realPath,
    name,
    sizeBytes,
    kind,
    decision: "skip",
    reason,
  });
  if (!realPath.startsWith(inside)) return skip("outside_directory");
  if (name.startsWith(".")) return skip("dotfile"); // only a file named directly: a listing omits dotfiles
  const kind = kindOf(name);
  if (kind === null) return skip("unsupported_type");
  if (sizeBytes === 0) return skip("empty", kind);
  if (sizeBytes > MAX_FILE_BYTES) return skip("too_large", kind);
  // Read for every kind, so a file the process may not read is never planned; only PDF/DOCX are sniffed.
  const head = await readHead(realPath).catch(failure);
  if (head instanceof FsFailure) return skip(head.reason, kind);
  if (kind !== "text" && sniffFileKind(head) !== kind) return skip("unsupported_type");
  return { path, realPath, name, sizeBytes, kind, decision: "upload" };
}

/** What an accepted extension stands for; null for any other name. */
function kindOf(name: string): FileKind | null {
  switch (MATTER_UPLOAD_EXT_RE.exec(name)?.[1].toLowerCase()) {
    case "pdf":
      return "pdf";
    case "docx":
      return "docx";
    case "txt":
    case "md":
      return "text";
    default:
      return null;
  }
}

/** The first 8 bytes (fewer for a shorter file), what sniffFileKind looks at. */
async function readHead(path: string): Promise<Uint8Array> {
  const file = await open(path, "r");
  try {
    const { buffer, bytesRead } = await file.read(new Uint8Array(8), 0, 8, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

/** `directory` ending in a separator; a root ("/", "C:\") already does. */
function withTrailingSep(directory: string): string {
  return directory.endsWith(sep) ? directory : directory + sep;
}

/** The entry of a path that led to no file, or that the cap left unseen. */
function unresolved(path: string, reason: SkipReason): PlanEntry {
  return { path, realPath: "", name: basename(path), sizeBytes: 0, kind: null, decision: "skip", reason };
}
