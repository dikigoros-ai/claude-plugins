import { describe, expect, it } from "vitest";
import { platformKey } from "./platform";

describe("platformKey", () => {
  it.each([
    ["darwin", "arm64", "darwin-arm64"],
    ["darwin", "x64", "darwin-x64"],
    ["linux", "x64", "linux-x64-gnu"],
    ["linux", "arm64", "linux-arm64-gnu"],
    ["win32", "x64", "win32-x64-msvc"],
    ["win32", "arm64", "win32-arm64-msvc"],
  ] as const)("maps %s %s to %s", (platform, arch, key) => {
    expect(platformKey(platform, arch)).toBe(key);
  });

  it.each([
    ["linux", "ia32"],
    ["linux", "arm"],
    ["darwin", "ia32"],
    ["win32", "ia32"],
    ["freebsd", "x64"],
    ["android", "arm64"],
  ] as const)("refuses %s %s", (platform, arch) => {
    expect(() => platformKey(platform, arch)).toThrow(new Error(`Unsupported platform: ${platform}-${arch}`));
  });
});
