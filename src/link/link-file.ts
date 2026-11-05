// The link file: `.dikigoros/matter.json` in a project folder, naming the matter the folder was opened
// as and what became of each file sent to it, so a later run reuses that matter and offers only what
// is new or changed. It is read with a schema, written whole through a temporary file and a rename,
// and holds no credential of any kind.

import { randomBytes } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import type { ProjectScan, ScannedFile } from "../files/scan";
import type { OutcomeStatus } from "../pipeline/upload-document";

/** The folder in the project root that holds the link file. */
export const LINK_DIR = ".dikigoros";
/** The link file's name inside LINK_DIR. */
export const LINK_FILE = "matter.json";

/** Every status an outcome can have; it fails to compile when OutcomeStatus gains or loses one. */
const OUTCOME_STATUSES = {
  ready: "ready",
  processing: "processing",
  failed: "failed",
  duplicate: "duplicate",
  skipped: "skipped",
} as const satisfies { [S in OutcomeStatus]: S };

/** What the link file records of one file sent to the matter. */
export interface LinkedFile {
  /** From the root, "/"-separated, as in the scan. */
  relativePath: string;
  /** The document's filename in the matter (see assignStoredNames). */
  storedName: string;
  /** The size and mtime the scan saw when the file was sent: a change to either makes it new again. */
  sizeBytes: number;
  mtimeMs: number;
  /** A PDF's or a DOCX's SHA-256; null for a text document and for a file never hashed. */
  sha256: string | null;
  /** The document's id, or its twin's; null when none is known. */
  docId: number | null;
  status: OutcomeStatus;
}

/** The whole link file. */
export interface MatterLink {
  version: 1;
  /** The API origin the matter lives on. */
  baseUrl: string;
  matterId: number;
  title: string;
  /** The matter's page. */
  url: string;
  /** When the matter was created, as an ISO 8601 timestamp. */
  createdAt: string;
  files: LinkedFile[];
}

/** What reading a folder's link file found: none, a valid one, or one that is not a link file and why. */
export type LinkRead = { kind: "none" } | { kind: "ok"; link: MatterLink } | { kind: "invalid"; reason: string };

/** The writes writeLink makes, so a test can interrupt one. */
export type LinkFs = Pick<typeof fsPromises, "mkdir" | "writeFile" | "rename" | "rm">;

const linkedFileSchema = z.strictObject({
  relativePath: z.string().min(1),
  storedName: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  mtimeMs: z.number(),
  sha256: z.string().nullable(),
  docId: z.number().int().nullable(),
  status: z.enum(OUTCOME_STATUSES),
});

const matterLinkSchema = z.strictObject({
  version: z.literal(1),
  baseUrl: z.string(),
  matterId: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  createdAt: z.string(),
  files: z.array(linkedFileSchema),
});

/**
 * Reads `<root>/.dikigoros/matter.json`. A file that is not there (or a root that is not) is none;
 * one that cannot be read, is not JSON or does not match the schema is invalid, with a short reason
 * that names where it failed and never quotes the file.
 */
export async function readLink(root: string): Promise<LinkRead> {
  let text: string;
  try {
    text = await readFile(join(root, LINK_DIR, LINK_FILE), "utf8");
  } catch (err) {
    const code = err instanceof Error && "code" in err ? String(err.code) : "unknown";
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "none" };
    return { kind: "invalid", reason: `the link file could not be read (${code})` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "invalid", reason: "the link file is not valid JSON" };
  }
  const parsed = matterLinkSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.length === 0 ? "its top level" : issue.path.join(".");
    return { kind: "invalid", reason: `the link file does not match its schema at ${where} (${issue.code})` };
  }
  return { kind: "ok", link: parsed.data };
}

/**
 * Writes `link` as `<root>/.dikigoros/matter.json`, creating the folder: the JSON (2-space indent,
 * a trailing newline) goes to a temporary file beside it, which is then renamed over the link file,
 * so a reader sees the old file or the new one and never part of one. A write or rename that fails
 * removes the temporary file and rejects, the old link file untouched.
 */
export async function writeLink(root: string, link: MatterLink, fsImpl: LinkFs = fsPromises): Promise<void> {
  const dir = join(root, LINK_DIR);
  await fsImpl.mkdir(dir, { recursive: true });
  const temp = join(dir, `.${LINK_FILE}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await fsImpl.writeFile(temp, `${JSON.stringify(link, null, 2)}\n`, "utf8");
    await fsImpl.rename(temp, join(dir, LINK_FILE));
  } catch (err) {
    await fsImpl.rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** A copy of `link` with `file`'s entry (by relativePath) replaced or added. */
export function recordOutcome(link: MatterLink, file: LinkedFile): MatterLink {
  const at = link.files.findIndex((entry) => entry.relativePath === file.relativePath);
  const files = at === -1 ? [...link.files, file] : link.files.map((entry, i) => (i === at ? file : entry));
  return { ...link, files };
}

/**
 * The scan with files the link records as ready or duplicate, same size and mtime, made
 * already_uploaded. A file the scan has ineligible keeps its own reason; a file whose size or mtime
 * changed stays eligible. Each folder's eligible count is counted again. The scan given is not changed.
 */
export function markUploaded(scan: ProjectScan, link: MatterLink): ProjectScan {
  const sent = new Map(
    link.files.filter((f) => f.status === "ready" || f.status === "duplicate").map((f) => [f.relativePath, f]),
  );
  const files = scan.files.map((file): ScannedFile => {
    const entry = sent.get(file.relativePath);
    if (!file.eligible || entry === undefined) return file;
    if (entry.sizeBytes !== file.sizeBytes || entry.mtimeMs !== file.mtimeMs) return file;
    return { ...file, eligible: false, reason: "already_uploaded" };
  });
  const eligible = new Map<string, number>();
  for (const file of files) {
    if (!file.eligible) continue;
    const folder = file.relativePath.includes("/") ? file.relativePath.slice(0, file.relativePath.lastIndexOf("/")) : "";
    eligible.set(folder, (eligible.get(folder) ?? 0) + 1);
  }
  const folders = scan.folders.map((folder) => ({ ...folder, eligible: eligible.get(folder.relativePath) ?? 0 }));
  return { ...scan, files, folders };
}
