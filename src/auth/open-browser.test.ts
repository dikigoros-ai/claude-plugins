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
  ] as const)("on %s runs %s detached, its output ignored, no console window, without waiting for it", (platform, command, args) => {
    const fake = fakeSpawn();
    openBrowser(VERIFICATION_URI_COMPLETE, fake.spawnImpl, platform);
    expect(fake.launches).toEqual([{ command, args, options: { detached: true, stdio: "ignore", windowsHide: true } }]);
    expect(fake.unrefs()).toBe(1);
  });

  it.each([
    ["an http: URL", "http://dikigoros-prod.eu.auth0.com/activate?user_code=WDJB-MJHT"],
    ["a file: URL", "file:///etc/passwd"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a command-line option", "-a Calculator"],
    ["an empty string", ""],
  ])("refuses %s: only an https:// URL is opened", (_kind, url) => {
    const fake = fakeSpawn();
    openBrowser(url, fake.spawnImpl, "darwin");
    expect(fake.launches).toEqual([]);
  });

  it.each([
    ["an ampersand", "https://dikigoros-prod.eu.auth0.com/activate?user_code=WDJB-MJHT&calc.exe"],
    ["a pipe", "https://dikigoros-prod.eu.auth0.com/activate?user_code=WDJB-MJHT|calc.exe"],
    ["a percent sign", "https://dikigoros-prod.eu.auth0.com/%PATH%"],
    ["a double quote and a space", 'https://dikigoros-prod.eu.auth0.com/" calc.exe'],
  ])("on win32 refuses a URL with %s, which cmd.exe would read as more than a URL", (_kind, url) => {
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
