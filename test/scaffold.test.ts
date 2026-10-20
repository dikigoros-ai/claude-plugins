import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("scaffold", () => {
  it("pins the native lock with sha512 integrity for every package", () => {
    const lock = JSON.parse(readFileSync(resolve("src/native/lock.generated.json"), "utf8")) as {
      version: number;
      packages: Record<string, { version: string; tarball: string; integrity: string }>;
      platforms: Record<string, { canvas: string; keyring: string }>;
    };
    expect(lock.version).toBe(1);
    expect(Object.keys(lock.packages)).toHaveLength(14);
    for (const [name, pin] of Object.entries(lock.packages)) {
      expect(pin.integrity, name).toMatch(/^sha512-[A-Za-z0-9+/=]+$/);
      expect(pin.tarball, name).toMatch(/^https:\/\/registry\.npmjs\.org\//);
    }
    for (const [key, entry] of Object.entries(lock.platforms)) {
      expect(lock.packages[entry.canvas], key).toBeDefined();
      expect(lock.packages[entry.keyring], key).toBeDefined();
    }
  });
});
