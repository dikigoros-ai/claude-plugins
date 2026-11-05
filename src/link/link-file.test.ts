// The link file against a temporary project folder: written, read back, refused when it is not one,
// kept whole when a write is interrupted; and the two pure helpers, recordOutcome and markUploaded,
// against a hand-built scan.

import * as fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectScan, ScannedFile } from "../files/scan";
import {
  LINK_DIR,
  LINK_FILE,
  type LinkedFile,
  markUploaded,
  type MatterLink,
  readLink,
  recordOutcome,
  writeLink,
} from "./link-file";

const SHA = "efa6110daca6ee9f16d4fd1abf39c79171aa1cbede47a8dfc469ce78d804db58";

const CLAIM: LinkedFile = {
  relativePath: "Pleadings/Αγωγή.pdf",
  storedName: "Αγωγή.pdf",
  sizeBytes: 48_213,
  mtimeMs: 1_762_300_000_000.5,
  sha256: SHA,
  docId: 31,
  status: "ready",
};

const LINK: MatterLink = {
  version: 1,
  baseUrl: "https://dikigoros.ai",
  matterId: 7,
  title: "Γεωργίου κατά Πέτρου",
  url: "https://dikigoros.ai/matters/7",
  createdAt: "2026-11-05T10:00:00.000Z",
  files: [CLAIM],
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dikigoros-link-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const linkPath = () => join(root, LINK_DIR, LINK_FILE);

/** Writes `content` as the link file, as some other program might have left it. */
async function putRaw(content: string): Promise<void> {
  await mkdir(join(root, LINK_DIR), { recursive: true });
  await writeFile(linkPath(), content);
}

/** Every key of a JSON value, at any depth. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]);
}

describe("readLink and writeLink", () => {
  it("reads back what it wrote, as 2-space JSON ending in a newline", async () => {
    await writeLink(root, LINK);
    expect(await readLink(root)).toStrictEqual({ kind: "ok", link: LINK });
    const text = await readFile(linkPath(), "utf8");
    expect(text).toBe(`${JSON.stringify(LINK, null, 2)}\n`);
  });

  it("creates the .dikigoros folder, and leaves nothing else in it", async () => {
    await writeLink(root, LINK);
    expect(await readdir(join(root, LINK_DIR))).toEqual([LINK_FILE]);
  });

  it("replaces an older link file", async () => {
    await writeLink(root, LINK);
    const updated = { ...LINK, files: [] };
    await writeLink(root, updated);
    expect(await readLink(root)).toStrictEqual({ kind: "ok", link: updated });
  });

  it("answers none when the folder has no link file", async () => {
    expect(await readLink(root)).toStrictEqual({ kind: "none" });
  });

  it("answers none when the folder itself is gone", async () => {
    expect(await readLink(join(root, "missing"))).toStrictEqual({ kind: "none" });
  });

  it.each([
    ["bad JSON", '{"version": 1,'],
    ["version 2", JSON.stringify({ ...LINK, version: 2 })],
    ["a missing field", JSON.stringify({ ...LINK, title: undefined })],
    ["an unknown field", JSON.stringify({ ...LINK, extra: true })],
    ["a matter id of 0", JSON.stringify({ ...LINK, matterId: 0 })],
    ["a file with an unknown status", JSON.stringify({ ...LINK, files: [{ ...CLAIM, status: "uploaded" }] })],
    ["a file without its sha256", JSON.stringify({ ...LINK, files: [{ ...CLAIM, sha256: undefined }] })],
    ["an array", "[]"],
  ])("answers invalid for %s, with a short reason that quotes none of the file", async (_what, content) => {
    await putRaw(content);
    const read = await readLink(root);
    expect(read.kind).toBe("invalid");
    if (read.kind !== "invalid") return;
    expect(read.reason.length).toBeGreaterThan(0);
    expect(read.reason.length).toBeLessThanOrEqual(120);
    expect(read.reason).not.toContain("Γεωργίου");
    expect(read.reason).not.toContain("uploaded");
  });

  it("takes a text file's link entry with a null sha256 and docId", async () => {
    const note: LinkedFile = {
      ...CLAIM,
      relativePath: "σημείωμα.txt",
      storedName: "σημείωμα.txt",
      sha256: null,
      docId: null,
      status: "failed",
    };
    await writeLink(root, { ...LINK, files: [note] });
    expect(await readLink(root)).toStrictEqual({ kind: "ok", link: { ...LINK, files: [note] } });
  });

  it("leaves the old file intact, and no temporary file, when the write is interrupted before the rename", async () => {
    await writeLink(root, LINK);
    const interrupted = {
      ...fsPromises,
      rename: async () => {
        throw new Error("interrupted");
      },
    };
    await expect(writeLink(root, { ...LINK, title: "Άλλος τίτλος" }, interrupted)).rejects.toThrow("interrupted");
    expect(await readLink(root)).toStrictEqual({ kind: "ok", link: LINK });
    expect(await readdir(join(root, LINK_DIR))).toEqual([LINK_FILE]);
  });

  it("removes the temporary file when writing it fails", async () => {
    await writeLink(root, LINK);
    const written: string[] = [];
    const failing = {
      ...fsPromises,
      writeFile: async (path: fsPromises.FileHandle | string | Buffer | URL) => {
        written.push(String(path));
        await fsPromises.writeFile(path, "{");
        throw new Error("ENOSPC: no space left on device");
      },
    } as typeof fsPromises;
    await expect(writeLink(root, LINK, failing)).rejects.toThrow("ENOSPC");
    expect(written).toHaveLength(1);
    expect(written[0].startsWith(join(root, LINK_DIR))).toBe(true);
    expect(written[0]).not.toBe(linkPath());
    expect(await readdir(join(root, LINK_DIR))).toEqual([LINK_FILE]);
    expect(await readLink(root)).toStrictEqual({ kind: "ok", link: LINK });
  });

  it("never writes a key named like a token", async () => {
    await writeLink(root, LINK);
    const keys = keysOf(JSON.parse(await readFile(linkPath(), "utf8")));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((key) => /token|secret|authorization/i.test(key))).toEqual([]);
  });
});

describe("recordOutcome", () => {
  it("replaces the entry with the same relative path, keeping the order", () => {
    const other: LinkedFile = { ...CLAIM, relativePath: "Old/Αγωγή.pdf", storedName: "Αγωγή (2).pdf", docId: 32 };
    const link = { ...LINK, files: [CLAIM, other] };
    const retried: LinkedFile = { ...CLAIM, status: "duplicate", docId: 12 };
    const next = recordOutcome(link, retried);
    expect(next.files).toStrictEqual([retried, other]);
    expect(link.files).toStrictEqual([CLAIM, other]); // the link given is not changed
  });

  it("adds an entry for a relative path it does not hold", () => {
    const added: LinkedFile = { ...CLAIM, relativePath: "Old/Αγωγή.pdf", storedName: "Αγωγή (2).pdf" };
    expect(recordOutcome(LINK, added).files).toStrictEqual([CLAIM, added]);
    expect(LINK.files).toStrictEqual([CLAIM]);
  });
});

describe("markUploaded", () => {
  /** An eligible PDF in `relativePath`, with CLAIM's size and mtime unless given. */
  function scanned(relativePath: string, over: Partial<ScannedFile> = {}): ScannedFile {
    const name = relativePath.split("/").at(-1) ?? relativePath;
    return {
      relativePath,
      path: `/Users/eleni/Matters/Georgiou/${relativePath}`,
      realPath: `/Users/eleni/Matters/Georgiou/${relativePath}`,
      name,
      sizeBytes: CLAIM.sizeBytes,
      mtimeMs: CLAIM.mtimeMs,
      kind: "pdf",
      eligible: true,
      ...over,
    };
  }

  function scanOf(files: ScannedFile[]): ProjectScan {
    return {
      root: "/Users/eleni/Matters/Georgiou",
      realRoot: "/Users/eleni/Matters/Georgiou",
      files,
      folders: [
        { relativePath: "", depth: 0, files: 1, eligible: 1 },
        { relativePath: "Pleadings", depth: 1, files: files.length - 1, eligible: files.filter((f) => f.eligible).length - 1 },
      ],
      truncated: null,
    };
  }

  const linkWith = (...files: LinkedFile[]): MatterLink => ({ ...LINK, files });

  it("marks a ready or duplicate entry with the same size and mtime already_uploaded, and counts it out of its folder", () => {
    const scan = scanOf([
      scanned("Σημειώσεις.pdf"),
      scanned("Pleadings/Αγωγή.pdf"),
      scanned("Pleadings/Υπεράσπιση.pdf"),
      scanned("Pleadings/Απάντηση.pdf"),
    ]);
    const link = linkWith(
      CLAIM,
      { ...CLAIM, relativePath: "Pleadings/Υπεράσπιση.pdf", status: "duplicate" },
      { ...CLAIM, relativePath: "Pleadings/Απάντηση.pdf", status: "processing" },
    );
    const marked = markUploaded(scan, link);
    expect(marked.files.map((f) => [f.relativePath, f.eligible, f.reason])).toEqual([
      ["Σημειώσεις.pdf", true, undefined],
      ["Pleadings/Αγωγή.pdf", false, "already_uploaded"],
      ["Pleadings/Υπεράσπιση.pdf", false, "already_uploaded"],
      ["Pleadings/Απάντηση.pdf", true, undefined],
    ]);
    expect(marked.folders).toStrictEqual([
      { relativePath: "", depth: 0, files: 1, eligible: 1 },
      { relativePath: "Pleadings", depth: 1, files: 3, eligible: 1 },
    ]);
  });

  it.each(["failed", "processing", "skipped"] as const)("leaves a file the link records as %s eligible", (status) => {
    const scan = scanOf([scanned("Σημειώσεις.pdf"), scanned("Pleadings/Αγωγή.pdf")]);
    const marked = markUploaded(scan, linkWith({ ...CLAIM, status }));
    expect(marked.files[1].eligible).toBe(true);
    expect(marked.files[1]).not.toHaveProperty("reason");
  });

  it.each([
    ["its size", { sizeBytes: CLAIM.sizeBytes + 1 }],
    ["its mtime", { mtimeMs: CLAIM.mtimeMs + 1000 }],
  ])("leaves a file whose %s changed since the upload eligible", (_what, change) => {
    const scan = scanOf([scanned("Σημειώσεις.pdf"), scanned("Pleadings/Αγωγή.pdf", change)]);
    const marked = markUploaded(scan, linkWith(CLAIM));
    expect(marked.files[1].eligible).toBe(true);
    expect(marked.folders[1].eligible).toBe(1);
  });

  it("keeps an ineligible file's own reason", () => {
    const tooLarge = scanned("Pleadings/Αγωγή.pdf", { eligible: false, reason: "too_large" });
    const marked = markUploaded(scanOf([scanned("Σημειώσεις.pdf"), tooLarge]), linkWith(CLAIM));
    expect(marked.files[1]).toStrictEqual(tooLarge);
  });

  it("returns a new scan and leaves the one given as it was", () => {
    const scan = scanOf([scanned("Σημειώσεις.pdf"), scanned("Pleadings/Αγωγή.pdf")]);
    const before = structuredClone(scan);
    const marked = markUploaded(scan, linkWith(CLAIM));
    expect(marked).not.toBe(scan);
    expect(scan).toStrictEqual(before);
  });
});
