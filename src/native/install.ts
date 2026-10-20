// Installs the two native packages the bundle cannot carry, @napi-rs/canvas (rasterises scanned
// PDF pages) and @napi-rs/keyring (the OS keychain), on first use: the exact tarballs pinned in
// lock.generated.json, each checked against its sha512 integrity before any of it is written, laid
// out as a real node_modules tree so that Node's own resolution finds each platform package from
// its JS package's loader. The tree is built in a temporary directory beside its target and renamed
// into place whole, its marker written last, so the directory named after the lock holds either a
// complete install or none; when another process renames its own copy in first, that one is used.
// Nothing is logged but one line per package, its name and version.

import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import * as tar from "tar";
import type { FetchLike } from "../auth/device-flow";
import type { PlatformKey } from "./platform";

export interface NativeLock {
  version: 1;
  packages: Record<string, { version: string; tarball: string; integrity: string }>;
  platforms: Record<string, { canvas: string; keyring: string }>;
}

/** Written last into a complete install, the lock hash as its content. */
const MARKER = ".ok";

/** The install directory's name: the first 12 hex digits of the sha256 of the lock's JSON. */
export function lockHash(lock: NativeLock): string {
  return createHash("sha256").update(JSON.stringify(lock)).digest("hex").slice(0, 12);
}

/**
 * The node_modules directory holding the platform's canvas and keyring packages, installed under
 * `<dataDir>/native/<lock hash>`: as found when its marker is there (`downloaded: false`), else
 * downloaded and extracted now. Rejects with "Download failed for <name>: <status, or the first
 * line of the failure>", with "Integrity mismatch for <name>" when a tarball is not the pinned one,
 * or with the file system's error, and leaves nothing of the failed install behind.
 */
export async function ensureNativeRuntime(opts: {
  dataDir: string;
  lock: NativeLock;
  platform: PlatformKey;
  fetchImpl: FetchLike;
  log: (line: string) => void;
}): Promise<{ nodeModulesDir: string; downloaded: boolean }> {
  const { dataDir, lock, platform, fetchImpl, log } = opts;
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
      const bytes = await download(name, pin.tarball, fetchImpl);
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

/** The tarball's bytes; a failure names the package and the status, or the error's first line. */
async function download(name: string, url: string, fetchImpl: FetchLike): Promise<Buffer> {
  const failed = (reason: string | number) => new Error(`Download failed for ${name}: ${reason}`);
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (err) {
    throw failed(firstLine(err));
  }
  if (!response.ok) throw failed(response.status);
  try {
    return Buffer.from(await response.arrayBuffer());
  } catch (err) {
    throw failed(firstLine(err));
  }
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split(/\r?\n/, 1)[0];
}

/** A tarball's integrity as npm records it: "sha512-" and the base64 of the digest. */
function integrityOf(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** Unpacks a package tarball into `dir`, created first, without its top directory (`package/`). */
async function extract(bytes: Buffer, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const unpack = tar.x({ cwd: dir, strip: 1 });
    unpack.on("error", reject);
    unpack.on("close", () => resolve());
    Readable.from(bytes).pipe(unpack);
  });
}
