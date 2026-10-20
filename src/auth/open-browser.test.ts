import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { openBrowser, type SpawnLike } from "./open-browser";

const VERIFICATION_URI_COMPLETE = "https://dikigoros-prod.eu.auth0.com/activate?user_code=WDJB-MJHT";

/** A spawn that records each launch and hands back a bare EventEmitter child with an unref counter. */
function fakeSpawn() {
  const launches: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  const children: EventEmitter[] = [];
  let unrefs = 0;
  const spawnImpl: SpawnLike = (command, args, options) => {
    launches.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), {
      unref: () => {
        unrefs += 1;
      },
    });
    children.push(child);
    return child;
  };
  return { spawnImpl, launches, children, unrefs: () => unrefs };
}

describe("openBrowser", () => {
  it.each([
    ["darwin", "open", [VERIFICATION_URI_COMPLETE]],
    ["win32", "cmd", ["/c", "start", "", VERIFICATION_URI_COMPLETE]],
    ["linux", "xdg-open", [VERIFICATION_URI_COMPLETE]],
  ] as const)("on %s runs %s detached, its output ignored, without waiting for it", (platform, command, args) => {
    const fake = fakeSpawn();
    openBrowser(VERIFICATION_URI_COMPLETE, fake.spawnImpl, platform);
    expect(fake.launches).toEqual([{ command, args, options: { detached: true, stdio: "ignore" } }]);
    expect(fake.unrefs()).toBe(1);
  });

  it.each([
    "http://dikigoros-prod.eu.auth0.com/activate?user_code=WDJB-MJHT",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "-a Calculator",
    "",
  ])("refuses %j: only an https:// URL is opened", (url) => {
    const fake = fakeSpawn();
    openBrowser(url, fake.spawnImpl, "darwin");
    expect(fake.launches).toEqual([]);
  });

  it.each([
    "https://dikigoros-prod.eu.auth0.com/activate?user_code=WDJB-MJHT&calc.exe",
    "https://dikigoros-prod.eu.auth0.com/activate?user_code=WDJB-MJHT|calc.exe",
    "https://dikigoros-prod.eu.auth0.com/%PATH%",
    'https://dikigoros-prod.eu.auth0.com/" calc.exe',
  ])("on win32 refuses %j, which cmd.exe would read as more than a URL", (url) => {
    const fake = fakeSpawn();
    openBrowser(url, fake.spawnImpl, "win32");
    expect(fake.launches).toEqual([]);
  });

  it("swallows a spawn that throws and an error the child reports later", () => {
    const throwing: SpawnLike = () => {
      throw new Error("spawn EAGAIN");
    };
    expect(() => openBrowser(VERIFICATION_URI_COMPLETE, throwing, "linux")).not.toThrow();
    const fake = fakeSpawn();
    openBrowser(VERIFICATION_URI_COMPLETE, fake.spawnImpl, "linux");
    expect(() => fake.children[0].emit("error", new Error("spawn xdg-open ENOENT"))).not.toThrow();
  });
});
