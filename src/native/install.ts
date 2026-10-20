// Installs the two native packages the bundle cannot carry, @napi-rs/canvas (rasterises scanned
// PDF pages) and @napi-rs/keyring (the OS keychain), on first use: the exact tarballs pinned in
// lock.generated.json (checked by readNativeLock), each download bounded by DOWNLOAD_TIMEOUT_MS and
// checked against its sha512 integrity before any of it is written, laid out as a real node_modules
// tree so that Node's own resolution finds each platform package from its JS package's loader. An
// entry tar cannot write fails the install. The tree is built in a temporary directory beside its
// target and renamed into place whole, its marker written last, so the directory named after the
// lock holds either a complete install or none; when another process renames its own copy in
// first, that one is used. Nothing is logged but one line per package, its name and version.

import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import * as tar from "tar";
import type { FetchLike } from "../auth/device-flow";
import type { PlatformKey } from "./platform";

export interface NativeLock {
  version: number;
  packages: Record<string, { version: string; tarball: string; integrity: string }>;
  platforms: Record<string, { canvas: string; keyring: string }>;
}

/** How long one package's download may take, answer and body, before it is aborted. */
export const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/** Written last into a complete install, the lock hash as its content. */
const MARKER = ".ok";

/**
 * The lock as the bundle imports it, its shape checked: version 1, every package pinned with a
 * version, a tarball and a sha512 integrity, every platform naming pinned packages. Anything else
 * throws Error("Invalid native lock: <what>").
 */
export function readNativeLock(json: unknown): NativeLock {
  const invalid = (what: string) => new Error(`Invalid native lock: ${what}`);
  if (!isRecord(json)) throw invalid("not an object");
  if (json.version !== 1) throw invalid(`version ${String(json.version)}, expected 1`);
  const { packages, platforms } = json;
  if (!isRecord(packages)) throw invalid("no packages");
  for (const [name, pin] of Object.entries(packages)) {
    if (!isRecord(pin) || typeof pin.version !== "string") throw invalid(`package ${name} has no version`);
    if (typeof pin.tarball !== "string") throw invalid(`package ${name} has no tarball`);
    if (typeof pin.integrity !== "string" || !pin.integrity.startsWith("sha512-")) {
      throw invalid(`package ${name} has no sha512 integrity`);
    }
  }
  if (!isRecord(platforms)) throw invalid("no platforms");
  for (const [key, entry] of Object.entries(platforms)) {
    for (const role of ["canvas", "keyring"]) {
      const name = isRecord(entry) ? entry[role] : undefined;
      if (typeof name !== "string") throw invalid(`platform ${key} names no ${role} package`);
      if (!Object.hasOwn(packages, name)) throw invalid(`platform ${key} names ${name}, which is not pinned`);
    }
  }
  return json as unknown as NativeLock;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The install directory's name: the first 12 hex digits of the sha256 of the lock's JSON. */
export function lockHash(lock: NativeLock): string {
  return createHash("sha256").update(JSON.stringify(lock)).digest("hex").slice(0, 12);
}

/**
 * The node_modules directory holding the platform's canvas and keyring packages, installed under
 * `<dataDir>/native/<lock hash>`: as found when its marker is there (`downloaded: false`), else
 * downloaded and extracted now. Rejects with "Download failed for <name>: <status, the timeout, or
 * the first line of the failure>" (the failure as its cause), with "Integrity mismatch for <name>"
 * when a tarball is not the pinned one, with tar's error for an entry it could not write, or with
 * the file system's error, and leaves nothing of the failed install behind.
 */
export async function ensureNativeRuntime(opts: {
  dataDir: string;
  lock: NativeLock;
  platform: PlatformKey;
  fetchImpl: FetchLike;
  log: (line: string) => void;
  /** How long each package's download may take; DOWNLOAD_TIMEOUT_MS unless given. */
  downloadTimeoutMs?: number;
}): Promise<{ nodeModulesDir: string; downloaded: boolean }> {
  const { dataDir, lock, platform, fetchImpl, log, downloadTimeoutMs = DOWNLOAD_TIMEOUT_MS } = opts;
  const hash = lockHash(lock);
  const target = join(dataDir, "native", hash);
  const nodeModulesDir = join(target, "node_modules");
  if (existsSync(join(target, MARKER))) return { nodeModulesDir, downloaded: false };

  const { canvas, keyring } = lock.platforms[platform];
  const tmp = join(dataDir, "native", `.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    for (const name of ["@napi-rs/canvas", canvas, "@napi-rs/keyring", keyring]) {
      const pin = lock.packages[name];
      log(`installing ${name} ${pin.version}`);
      const bytes = await download(name, pin.tarball, fetchImpl, downloadTimeoutMs);
      if (integrityOf(bytes) !== pin.integrity) throw new Error(`Integrity mismatch for ${name}`);
      await extract(bytes, join(tmp, "node_modules", name));
    }
    await writeFile(join(tmp, MARKER), hash);
    try {
      await rename(tmp, target);
    } catch (err) {
      // Unless another process renamed its own complete install of this lock into place first.
      if (!existsSync(join(target, MARKER))) throw err;
    }
  } finally {
    // Gone after the rename; otherwise a failed install's tree, or the copy that lost the race. A
    // tree that cannot be removed only takes space: it never passes for an install.
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  return { nodeModulesDir, downloaded: true };
}

/**
 * The tarball's bytes, the answer and the body read within `timeoutMs`. A failure names the
 * package and the status, the timeout, or the first line of the error, which is kept as its cause.
 */
async function download(name: string, url: string, fetchImpl: FetchLike, timeoutMs: number): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: controller.signal });
    if (response.ok) return Buffer.from(await response.arrayBuffer());
  } catch (err) {
    const reason = controller.signal.aborted ? `timed out after ${timeoutMs / 1000} s` : firstLine(err);
    throw new Error(`Download failed for ${name}: ${reason}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }
  throw new Error(`Download failed for ${name}: ${response.status}`);
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split(/\r?\n/, 1)[0];
}

/** A tarball's integrity as npm records it: "sha512-" and the base64 of the digest. */
function integrityOf(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/**
 * Unpacks a package tarball into `dir`, created first, without its top directory (`package/`).
 * tar runs non-strict so that it still closes every file it opened; the first entry it could not
 * write (any warning but TAR_ENTRY_INFO) then fails the extraction once tar has closed.
 */
async function extract(bytes: Buffer, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    let failure: Error | undefined;
    const unpack = tar.x({
      cwd: dir,
      strip: 1,
      preserveOwner: false,
      noMtime: true,
      onwarn: (code, message, data) => {
        if (code !== "TAR_ENTRY_INFO") failure ??= data instanceof Error ? data : new Error(`${code}: ${message}`);
      },
    });
    unpack.on("error", reject);
    unpack.on("close", () => {
      if (failure) reject(failure);
      else resolve();
    });
    Readable.from(bytes).pipe(unpack);
  });
}
