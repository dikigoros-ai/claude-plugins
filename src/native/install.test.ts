// ensureNativeRuntime against a fake npm registry on 127.0.0.1. The four packages a linux-x64-gnu
// install fetches are tiny fakes packed here as npm publishes them (package/package.json and
// package/index.js, its main); the test lock pins the bytes the registry serves. Each JS package's
// index.js re-exports its platform package, which Node has to find in the installed tree, as the
// real loaders' require does.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../auth/device-flow";
import { ensureNativeRuntime, lockHash, type NativeLock } from "./install";
import { loadCanvasModule, loadKeyringBinding } from "./load";

const CANVAS_PLATFORM = "@napi-rs/canvas-linux-x64-gnu";
const KEYRING_PLATFORM = "@napi-rs/keyring-linux-x64-gnu";

interface FakePackage {
  name: string;
  version: string;
  /** Where the registry serves its tarball, in npm's layout. */
  path: string;
  /** Its index.js. */
  index: string;
}

const FAKES: FakePackage[] = [
  {
    name: "@napi-rs/canvas",
    version: "1.0.11",
    path: "/@napi-rs/canvas/-/canvas-1.0.11.tgz",
    index: `module.exports = { name: "@napi-rs/canvas", binding: require("${CANVAS_PLATFORM}") };\n`,
  },
  {
    name: CANVAS_PLATFORM,
    version: "1.0.11",
    path: "/@napi-rs/canvas-linux-x64-gnu/-/canvas-linux-x64-gnu-1.0.11.tgz",
    index: `module.exports = { name: "${CANVAS_PLATFORM}" };\n`,
  },
  {
    name: "@napi-rs/keyring",
    version: "2.1.2",
    path: "/@napi-rs/keyring/-/keyring-2.1.2.tgz",
    index: `module.exports = { name: "@napi-rs/keyring", binding: require("${KEYRING_PLATFORM}") };\n`,
  },
  {
    name: KEYRING_PLATFORM,
    version: "2.1.2",
    path: "/@napi-rs/keyring-linux-x64-gnu/-/keyring-linux-x64-gnu-2.1.2.tgz",
    index: `module.exports = { name: "${KEYRING_PLATFORM}" };\n`,
  },
];

/** A package tarball as npm publishes one: gzipped, every file under `package/`. */
async function pack(name: string, version: string, index: string): Promise<Buffer> {
  const cwd = await mkdtemp(join(tmpdir(), "dikigoros-native-pack-"));
  try {
    await mkdir(join(cwd, "package"));
    await writeFile(join(cwd, "package", "package.json"), JSON.stringify({ name, version, main: "index.js" }));
    await writeFile(join(cwd, "package", "index.js"), index);
    return await tar.c({ gzip: true, cwd, portable: true }, ["package"]).concat();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** The integrity npm records for a tarball (`dist.integrity`). */
function integrityOf(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

// ---------- The fake registry ----------

/** The genuine tarball of each fake, by registry path. */
const genuine = new Map<string, Buffer>();
/** What the registry serves, by path: the genuine tarballs unless a test swaps one. Else 404. */
let served = new Map<string, Buffer>();
/** Paths whose answer stops after its first bytes, the connection dropped. */
const cutOff = new Set<string>();

const registry = createServer((req, res) => {
  const path = req.url ?? "/";
  const body = served.get(path);
  if (!body) {
    res.writeHead(404).end();
  } else if (cutOff.has(path)) {
    res.writeHead(200, { "Content-Length": String(body.length) });
    res.write(body.subarray(0, 16), () => res.destroy());
  } else {
    res.writeHead(200, { "Content-Length": String(body.length) }).end(body);
  }
});
let origin = "";
let lock: NativeLock;

beforeAll(async () => {
  await new Promise<void>((resolve) => registry.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;
  const packages: NativeLock["packages"] = {};
  for (const fake of FAKES) {
    const bytes = await pack(fake.name, fake.version, fake.index);
    genuine.set(fake.path, bytes);
    packages[fake.name] = { version: fake.version, tarball: origin + fake.path, integrity: integrityOf(bytes) };
  }
  // Another platform's pins, as in the real lock: nothing is served at their paths, and a
  // linux-x64-gnu install never asks for them.
  packages["@napi-rs/canvas-darwin-arm64"] = {
    version: "1.0.11",
    tarball: `${origin}/@napi-rs/canvas-darwin-arm64/-/canvas-darwin-arm64-1.0.11.tgz`,
    integrity: integrityOf(Buffer.from("canvas-darwin-arm64")),
  };
  packages["@napi-rs/keyring-darwin-arm64"] = {
    version: "2.1.2",
    tarball: `${origin}/@napi-rs/keyring-darwin-arm64/-/keyring-darwin-arm64-2.1.2.tgz`,
    integrity: integrityOf(Buffer.from("keyring-darwin-arm64")),
  };
  lock = {
    version: 1,
    packages,
    platforms: {
      "darwin-arm64": { canvas: "@napi-rs/canvas-darwin-arm64", keyring: "@napi-rs/keyring-darwin-arm64" },
      "linux-x64-gnu": { canvas: CANVAS_PLATFORM, keyring: KEYRING_PLATFORM },
    },
  };
});

let dataDir = "";

beforeEach(async () => {
  served = new Map(genuine);
  cutOff.clear();
  dataDir = await mkdtemp(join(tmpdir(), "dikigoros-native-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

afterAll(async () => {
  registry.closeAllConnections();
  await new Promise<void>((resolve) => registry.close(() => resolve()));
});

// ---------- Helpers ----------

type InstallOptions = Parameters<typeof ensureNativeRuntime>[0];

/** A linux-x64-gnu install of the test lock into the test's data directory, quiet, over fetch. */
function options(overrides: Partial<InstallOptions> = {}): InstallOptions {
  return { dataDir, lock, platform: "linux-x64-gnu", fetchImpl: fetch, log: () => {}, ...overrides };
}

/** fetch, recording the URL of every request. */
function recordingFetch(): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    return fetch(input, init);
  };
  return { fetchImpl, urls };
}

/** What is left in <dataDir>/native: nothing when the directory was never made. */
function nativeEntries(): string[] {
  const dir = join(dataDir, "native");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe("lockHash", () => {
  it("is the first 12 hex digits of the sha256 of the lock's JSON", () => {
    // printf '%s' '{"version":1,"packages":{},"platforms":{}}' | shasum -a 256
    expect(lockHash({ version: 1, packages: {}, platforms: {} })).toBe("793af9153128");
  });
});

describe("ensureNativeRuntime", () => {
  it("installs the platform's four packages under <dataDir>/native/<lock hash>/node_modules", async () => {
    const { fetchImpl, urls } = recordingFetch();
    const lines: string[] = [];
    const result = await ensureNativeRuntime(options({ fetchImpl, log: (line) => lines.push(line) }));

    const target = join(dataDir, "native", lockHash(lock));
    expect(result).toEqual({ nodeModulesDir: join(target, "node_modules"), downloaded: true });
    expect(urls).toEqual([
      `${origin}/@napi-rs/canvas/-/canvas-1.0.11.tgz`,
      `${origin}/@napi-rs/canvas-linux-x64-gnu/-/canvas-linux-x64-gnu-1.0.11.tgz`,
      `${origin}/@napi-rs/keyring/-/keyring-2.1.2.tgz`,
      `${origin}/@napi-rs/keyring-linux-x64-gnu/-/keyring-linux-x64-gnu-2.1.2.tgz`,
    ]);
    expect(lines).toEqual([
      "installing @napi-rs/canvas 1.0.11",
      "installing @napi-rs/canvas-linux-x64-gnu 1.0.11",
      "installing @napi-rs/keyring 2.1.2",
      "installing @napi-rs/keyring-linux-x64-gnu 2.1.2",
    ]);
    for (const fake of FAKES) {
      expect(readFileSync(join(target, "node_modules", fake.name, "index.js"), "utf8"), fake.name).toBe(fake.index);
    }
    expect(readFileSync(join(target, ".ok"), "utf8")).toBe(lockHash(lock));
    expect(nativeEntries()).toEqual([lockHash(lock)]);
  });

  it("lays the packages out so that each loader finds its platform package beside it", async () => {
    const { nodeModulesDir } = await ensureNativeRuntime(options());

    expect(loadCanvasModule(nodeModulesDir)).toEqual({
      name: "@napi-rs/canvas",
      binding: { name: "@napi-rs/canvas-linux-x64-gnu" },
    });
    expect(loadKeyringBinding(nodeModulesDir)).toEqual({
      name: "@napi-rs/keyring",
      binding: { name: "@napi-rs/keyring-linux-x64-gnu" },
    });
  });

  it("finds the finished install on the next call and fetches nothing", async () => {
    const first = await ensureNativeRuntime(options());
    const { fetchImpl, urls } = recordingFetch();
    const lines: string[] = [];

    const again = await ensureNativeRuntime(options({ fetchImpl, log: (line) => lines.push(line) }));

    expect(again).toEqual({ nodeModulesDir: first.nodeModulesDir, downloaded: false });
    expect(urls).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("installs a changed lock afresh instead of reusing the install of the old one", async () => {
    const first = await ensureNativeRuntime(options());
    const index = `module.exports = { name: "@napi-rs/canvas", next: true, binding: require("${CANVAS_PLATFORM}") };\n`;
    const next = await pack("@napi-rs/canvas", "1.0.12", index);
    served.set("/@napi-rs/canvas/-/canvas-1.0.12.tgz", next);
    const upgraded: NativeLock = {
      ...lock,
      packages: {
        ...lock.packages,
        "@napi-rs/canvas": {
          version: "1.0.12",
          tarball: `${origin}/@napi-rs/canvas/-/canvas-1.0.12.tgz`,
          integrity: integrityOf(next),
        },
      },
    };

    const second = await ensureNativeRuntime(options({ lock: upgraded }));

    expect(second.downloaded).toBe(true);
    expect(second.nodeModulesDir).not.toBe(first.nodeModulesDir);
    expect(loadCanvasModule(second.nodeModulesDir)).toEqual({
      name: "@napi-rs/canvas",
      next: true,
      binding: { name: "@napi-rs/canvas-linux-x64-gnu" },
    });
  });

  it("rejects a tarball that is not the pinned one and leaves nothing behind", async () => {
    const tampered = await pack(KEYRING_PLATFORM, "2.1.2", `module.exports = { name: "tampered" };\n`);
    served.set("/@napi-rs/keyring-linux-x64-gnu/-/keyring-linux-x64-gnu-2.1.2.tgz", tampered);

    await expect(ensureNativeRuntime(options())).rejects.toThrow(
      new Error("Integrity mismatch for @napi-rs/keyring-linux-x64-gnu"),
    );
    expect(nativeEntries()).toEqual([]);
  });

  it("checks a download's integrity before extracting any of it", async () => {
    // A captive portal's page in place of the tarball: extracting it first would fail as a bad archive.
    served.set("/@napi-rs/canvas/-/canvas-1.0.11.tgz", Buffer.from("<!doctype html><title>Sign in to the network</title>"));

    await expect(ensureNativeRuntime(options())).rejects.toThrow(new Error("Integrity mismatch for @napi-rs/canvas"));
    expect(nativeEntries()).toEqual([]);
  });

  it("rejects a refused download with the package and the status", async () => {
    served.delete("/@napi-rs/keyring/-/keyring-2.1.2.tgz");

    await expect(ensureNativeRuntime(options())).rejects.toThrow(new Error("Download failed for @napi-rs/keyring: 404"));
    expect(nativeEntries()).toEqual([]);
  });

  it("rejects a download that got no answer with the first line of the failure", async () => {
    const fetchImpl: FetchLike = async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/canvas-linux-x64-gnu-1.0.11.tgz")) {
        throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org\n    at GetAddrInfoReqWrap.onlookupall");
      }
      return fetch(input, init);
    };

    await expect(ensureNativeRuntime(options({ fetchImpl }))).rejects.toThrow(
      new Error("Download failed for @napi-rs/canvas-linux-x64-gnu: getaddrinfo ENOTFOUND registry.npmjs.org"),
    );
    expect(nativeEntries()).toEqual([]);
  });

  it("rejects a download cut off before its end as a failed download", async () => {
    cutOff.add("/@napi-rs/keyring/-/keyring-2.1.2.tgz");

    await expect(ensureNativeRuntime(options())).rejects.toThrow(/^Download failed for @napi-rs\/keyring: [^\n]+$/);
    expect(nativeEntries()).toEqual([]);
  });

  it("takes the install another process renamed into place first", async () => {
    const target = join(dataDir, "native", lockHash(lock));
    const fetchImpl: FetchLike = async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/keyring-linux-x64-gnu-2.1.2.tgz")) {
        // The other process finishes the same install while this one fetches its last package.
        await ensureNativeRuntime(options());
        await writeFile(join(target, "winner"), "the other process");
      }
      return fetch(input, init);
    };

    const result = await ensureNativeRuntime(options({ fetchImpl }));

    expect(result).toEqual({ nodeModulesDir: join(target, "node_modules"), downloaded: true });
    expect(readFileSync(join(target, "winner"), "utf8")).toBe("the other process");
    expect(nativeEntries()).toEqual([lockHash(lock)]);
  });

  it("rejects with the rename's error when no install took its place, removing its own tree", async () => {
    const target = join(dataDir, "native", lockHash(lock));
    await mkdir(join(dataDir, "native"));
    await writeFile(target, "not a directory");

    await expect(ensureNativeRuntime(options())).rejects.toMatchObject({ syscall: "rename" });
    expect(nativeEntries()).toEqual([lockHash(lock)]);
  });
});
