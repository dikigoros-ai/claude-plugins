// Pins the native packages the helper installs on first use: their exact
// tarball URLs and sha512 integrity, as published on registry.npmjs.org.
// Run `npm run pin-native` (network) whenever a native version changes; the
// output is committed at src/native/lock.generated.json and read by the
// bundle at runtime (src/native/install.ts).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const VERSIONS = {
  "@napi-rs/canvas": "1.0.11",
  "@napi-rs/keyring": "2.1.2",
} as const;

export const PLATFORM_KEYS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64-gnu",
  "linux-arm64-gnu",
  "win32-x64-msvc",
  "win32-arm64-msvc",
] as const;

interface PackagePin {
  version: string;
  tarball: string;
  integrity: string;
}

function view(name: string, version: string): PackagePin {
  const out = execFileSync("npm", ["view", `${name}@${version}`, "--json", "dist.tarball", "dist.integrity"], {
    encoding: "utf8",
  });
  const parsed = JSON.parse(out) as Record<string, string> | Record<string, string>[];
  const record = Array.isArray(parsed) ? parsed[0] : parsed;
  const tarball = record["dist.tarball"];
  const integrity = record["dist.integrity"];
  if (!tarball || !integrity || !integrity.startsWith("sha512-")) {
    throw new Error(`npm view ${name}@${version}: missing tarball or sha512 integrity`);
  }
  return { version, tarball, integrity };
}

const packages: Record<string, PackagePin> = {};
for (const [base, version] of Object.entries(VERSIONS)) {
  packages[base] = view(base, version);
  for (const key of PLATFORM_KEYS) {
    const name = `${base}-${key}`;
    packages[name] = view(name, version);
  }
}

const platforms: Record<string, { canvas: string; keyring: string }> = {};
for (const key of PLATFORM_KEYS) {
  platforms[key] = { canvas: `@napi-rs/canvas-${key}`, keyring: `@napi-rs/keyring-${key}` };
}

const lock = { version: 1, packages, platforms };
const target = resolve("src/native/lock.generated.json");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(lock, null, 2) + "\n");
console.log(`wrote ${target}: ${Object.keys(packages).length} packages, ${PLATFORM_KEYS.length} platforms`);
