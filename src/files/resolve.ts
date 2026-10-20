// The upload plan behind `upload_to_matter`: the absolute paths the model passes, resolved to the
// files that would be uploaded and the ones that would not (each with its reason), plus a digest of
// the uploads that the confirm call compares, so a folder that changed in between is listed again.
// It reads the filesystem and changes nothing.

import { createHash } from "node:crypto";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
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
  | "not_a_file"
  | "dotfile"
  | "unsupported_type"
  | "too_large"
  | "empty"
  | "outside_directory"
  | "duplicate_path"
  | "too_many_files";

export interface PlanEntry {
  /** The path as given; for a file listed from a directory, that directory as given joined with its name. */
  path: string;
  /** Where `path` really leads, symlinks resolved; "" when it never resolved. */
  realPath: string;
  /** The basename of `path`, verbatim (Greek letters, spaces): the document's filename. */
  name: string;
  /** From `stat`, so a symlink's target; 0 when the path never resolved. */
  sizeBytes: number;
  /** Set once the extension and the magic bytes check out; null for entries skipped before that. */
  kind: FileKind | null;
  decision: "upload" | "skip";
  /** Present exactly when `decision` is "skip". */
  reason?: SkipReason;
}

export interface UploadPlan {
  entries: PlanEntry[];
  digest: string;
}

/**
 * The plan for `paths`, in the caller's order. Only absolute paths are taken: the server's working
 * directory is unknown, so nothing is resolved against it. A file stands for itself; a directory
 * for its direct children that are files or symlinks to files (subdirectories are not entered).
 * Every candidate gets the reason of the first check it fails: its real path stays inside the
 * directory that was named (for a named file, the one it sits in); not a dotfile; an accepted
 * extension whose magic bytes agree; not empty; at most MAX_FILE_BYTES; not planned already;
 * within MAX_FILES_PER_CALL. A path that cannot be read (gone, dangling, no permission) is
 * not_found.
 */
export async function resolveUploadPlan(paths: string[]): Promise<UploadPlan> {
  const entries: PlanEntry[] = [];
  const planned = new Set<string>(); // real paths that passed every other check, capped ones included
  for (const path of paths) {
    for (const entry of await resolvePath(path)) {
      if (entry.decision === "skip") {
        entries.push(entry);
      } else if (planned.has(entry.realPath)) {
        entries.push({ ...entry, decision: "skip", reason: "duplicate_path" });
      } else {
        planned.add(entry.realPath);
        const capped = planned.size > MAX_FILES_PER_CALL;
        entries.push(capped ? { ...entry, decision: "skip", reason: "too_many_files" } : entry);
      }
    }
  }
  return { entries, digest: planDigest(entries) };
}

/** sha256 over the sorted "realPath\0sizeBytes" of the upload entries, first 16 hex characters. */
export function planDigest(entries: PlanEntry[]): string {
  const uploads = entries.filter((e) => e.decision === "upload").map((e) => `${e.realPath}\0${e.sizeBytes}`);
  return createHash("sha256").update(uploads.sort().join("\n")).digest("hex").slice(0, 16);
}

interface Candidate {
  path: string;
  sizeBytes: number;
}

/** One path as given: the entries of its candidate files, or one entry saying why it has none. */
async function resolvePath(path: string): Promise<PlanEntry[]> {
  if (!isAbsolute(path)) return [unresolved(path, "not_absolute")];
  const stats = await stat(path).catch(() => null);
  if (stats === null) return [unresolved(path, "not_found")];
  if (!stats.isFile() && !stats.isDirectory()) return [unresolved(path, "not_a_file")];
  // A named file is contained by the directory it sits in; a named directory's files by that directory.
  const directory = stats.isFile() ? dirname(path) : path;
  const candidates = stats.isFile() ? [{ path, sizeBytes: stats.size }] : await listFiles(path).catch(() => null);
  // join, not `+ sep`: a root ("/", "C:\") already ends in a separator.
  const inside = await realpath(directory).then((real) => join(real, sep), () => null);
  if (candidates === null || inside === null) return [unresolved(path, "not_found")];
  const entries: PlanEntry[] = [];
  for (const candidate of candidates) entries.push(await resolveCandidate(candidate, inside));
  return entries;
}

/** A directory's direct children that are files or symlinks to files, sorted by name so the plan
 *  (and which files the cap leaves out) does not depend on the filesystem's listing order. */
async function listFiles(directory: string): Promise<Candidate[]> {
  const children = await readdir(directory, { withFileTypes: true });
  const names = children.filter((c) => c.isFile() || c.isSymbolicLink()).map((c) => c.name).sort();
  const files: Candidate[] = [];
  for (const name of names) {
    const path = join(directory, name);
    const stats = await stat(path).catch(() => null); // a symlink may lead to a directory, or nowhere
    if (stats?.isFile()) files.push({ path, sizeBytes: stats.size });
  }
  return files;
}

/** One candidate file: the first check it fails decides its reason. `inside` is the real path of the
 *  directory that was named, with a trailing separator. */
async function resolveCandidate({ path, sizeBytes }: Candidate, inside: string): Promise<PlanEntry> {
  const realPath = await realpath(path).catch(() => null);
  if (realPath === null) return unresolved(path, "not_found");
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
  if (name.startsWith(".")) return skip("dotfile");
  const kind = kindOf(name);
  if (kind === null) return skip("unsupported_type");
  if (kind !== "text") {
    const head = await readHead(realPath).catch(() => null);
    if (head === null) return skip("not_found");
    if (sniffFileKind(head) !== kind) return skip("unsupported_type");
  }
  if (sizeBytes === 0) return skip("empty", kind);
  if (sizeBytes > MAX_FILE_BYTES) return skip("too_large", kind);
  return { path, realPath, name, sizeBytes, kind, decision: "upload" };
}

/** The kind an accepted extension claims; null outside the accept list. */
function kindOf(name: string): FileKind | null {
  if (!MATTER_UPLOAD_EXT_RE.test(name)) return null;
  if (TEXT_DOCUMENT_EXT_RE.test(name)) return "text";
  return /\.pdf$/i.test(name) ? "pdf" : "docx";
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

/** The entry of a path that led to no file. */
function unresolved(path: string, reason: SkipReason): PlanEntry {
  return { path, realPath: "", name: basename(path), sizeBytes: 0, kind: null, decision: "skip", reason };
}
