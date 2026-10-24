// Opens the sign-in page in the lawyer's default browser, best effort: the prompt the tool returns
// carries the same URL, so a machine without a browser loses only the convenience.

import { spawn, type SpawnOptions } from "node:child_process";

/** child_process.spawn as far as openBrowser uses it. */
export type SpawnLike = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => { on(event: "error", listener: (err: Error) => void): unknown; unref(): void };

/** What cmd.exe would read as syntax rather than as part of the URL `start` is given. */
const CMD_SYNTAX = /[\s"%&()<>^|!]/;

/**
 * Hands an `https://` URL to the platform's opener (`open`, `cmd /c start`, `xdg-open`), detached
 * and not waited for. Any other URL is refused, and so on Windows is one carrying cmd.exe syntax.
 * Never throws: a missing opener or a failed spawn is swallowed.
 */
export function openBrowser(url: string, spawnImpl: SpawnLike = spawn, platform: NodeJS.Platform = process.platform): void {
  if (!url.startsWith("https://")) return;
  if (platform === "win32" && CMD_SYNTAX.test(url)) return;
  const [command, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    // windowsHide: no console window for the detached cmd.exe on Windows (ignored elsewhere)
    const child = spawnImpl(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {}); // e.g. no xdg-open on this machine: spawn reports ENOENT here
    child.unref();
  } catch {
    // spawn can also throw synchronously; opening the browser is a convenience, never a failure
  }
}
