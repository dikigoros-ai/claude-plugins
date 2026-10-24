// The key the native lock files each platform's canvas and keyring packages under, from Node's
// process.platform and process.arch. Linux is taken to be glibc: a musl system is not detected and
// gets the -gnu packages, which then fail to load.

export type PlatformKey =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-x64-gnu"
  | "linux-arm64-gnu"
  | "win32-x64-msvc"
  | "win32-arm64-msvc";

const KEYS = new Map<string, PlatformKey>([
  ["darwin-arm64", "darwin-arm64"],
  ["darwin-x64", "darwin-x64"],
  ["linux-x64", "linux-x64-gnu"],
  ["linux-arm64", "linux-arm64-gnu"],
  ["win32-x64", "win32-x64-msvc"],
  ["win32-arm64", "win32-arm64-msvc"],
]);

/** Throws "Unsupported platform: <platform>-<arch>" for anything but the six keys above. */
export function platformKey(platform: NodeJS.Platform, arch: string): PlatformKey {
  const key = KEYS.get(`${platform}-${arch}`);
  if (key === undefined) throw new Error(`Unsupported platform: ${platform}-${arch}`);
  return key;
}
