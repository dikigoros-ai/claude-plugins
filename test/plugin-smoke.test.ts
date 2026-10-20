// The committed bundle, run the way Claude runs the plugin's local server: node on
// plugins/dikigoros/server/dikigoros-upload.mjs with the plugin's environment, JSON-RPC on stdin and
// stdout. It needs `npm run build` first, and fails rather than skips when the bundle is missing.
// The --extract-check run shows the bundled pdf.js working with the files the build put beside the
// bundle: it imports the worker from there, reads a standard font from there, and renders the
// scanned page through the canvas factory. The canvas is the dev dependency, named through
// DIKIGOROS_HELPER_NATIVE_DIR, so nothing is downloaded.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALLOWED_ORIGINS } from "../src/config";
import { twoPagePdf } from "./support/pdf-fixtures";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_ROOT = join(ROOT, "plugins", "dikigoros");
const BUNDLE = join(PLUGIN_ROOT, "server", "dikigoros-upload.mjs");
/** A run still going after this long is killed, and its test fails on the exit. */
const RUN_LIMIT_MS = 30_000;

interface Run {
  /** null when the process was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
}

interface ListedTool {
  name: string;
  title?: string;
  annotations?: { destructiveHint?: boolean };
  inputSchema?: { type?: string };
}

interface JsonRpcLine {
  jsonrpc?: string;
  id?: number;
  result?: { serverInfo?: { name: string; version: string }; tools?: ListedTool[] };
}

/** What a 2025-era client sends to start a session and list the tools. */
const LIST_TOOLS = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
];

let tmp: string;
let dataDir: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "dikigoros-smoke-"));
  dataDir = join(tmp, "data");
  await mkdir(dataDir);
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** This process's environment without the helper's own variables, which a developer's shell may set. */
function hostEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("DIKIGOROS_") && !name.startsWith("CLAUDE_PLUGIN_")),
  );
}

/** Whether `stdout` holds a complete JSON line answering request `id`. */
function answered(stdout: string, id: number): boolean {
  return stdout
    .split("\n")
    .slice(0, -1)
    .some((line) => {
      try {
        return (JSON.parse(line) as JsonRpcLine).id === id;
      } catch {
        return false;
      }
    });
}

/**
 * Runs the bundle with `args` and `env` over the host's environment, and resolves once it has
 * exited. `input.messages` are written to stdin one JSON line each, and stdin stays open until
 * stdout answers request `input.until`: the server stops at the end of stdin, dropping whatever it
 * has not answered. Without input, stdin is closed at once.
 */
async function runBundle(
  args: string[],
  env: Record<string, string>,
  input?: { messages: object[]; until: number },
): Promise<Run> {
  expect(existsSync(BUNDLE), `${BUNDLE} is missing: run npm run build`).toBe(true);
  const child = spawn(process.execPath, [BUNDLE, ...args], { env: { ...hostEnv(), ...env } });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    if (input !== undefined && !child.stdin.writableEnded && answered(stdout, input.until)) child.stdin.end();
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  // A process that exits before reading its stdin breaks the pipe; its exit code tells the story.
  child.stdin.on("error", () => {});
  if (input === undefined) child.stdin.end();
  else for (const message of input.messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  const timer = setTimeout(() => child.kill(), RUN_LIMIT_MS);
  try {
    const [code] = (await once(child, "close")) as [number | null];
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

describe("the bundled dikigoros-upload server", () => {
  it("answers initialize and tools/list with its two tools, writing nothing but JSON-RPC to stdout", async () => {
    const run = await runBundle(
      [],
      { DIKIGOROS_BASE_URL: "http://localhost:3000", DIKIGOROS_AUTH0_CLIENT_ID: "test", CLAUDE_PLUGIN_DATA: dataDir },
      { messages: LIST_TOOLS, until: 2 },
    );
    expect(run.code, run.stderr).toBe(0);

    const lines = run.stdout.split("\n");
    expect(lines.pop(), "stdout ends with a newline").toBe("");
    for (const line of lines) expect(() => JSON.parse(line), `a line on stdout: ${line}`).not.toThrow();
    const messages = lines.map((line) => JSON.parse(line) as JsonRpcLine);
    for (const message of messages) expect(message.jsonrpc).toBe("2.0");

    const { version } = JSON.parse(readFileSync(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")) as {
      version: string;
    };
    const serverInfo = messages.find((message) => message.id === 1)?.result?.serverInfo;
    expect(serverInfo).toMatchObject({ name: "dikigoros-upload", version });

    const tools = messages.find((message) => message.id === 2)?.result?.tools ?? [];
    expect(tools.map((tool) => tool.name).sort()).toEqual(["create_matter", "upload_to_matter"]);
    for (const tool of tools) {
      expect(tool.title, tool.name).toMatch(/\S/);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
      expect(tool.inputSchema, tool.name).toMatchObject({ type: "object" });
    }
  });

  it("refuses a DIKIGOROS_BASE_URL other than the allowed origins with one stderr line and exit 1", async () => {
    const run = await runBundle([], {
      DIKIGOROS_BASE_URL: "https://example.com",
      DIKIGOROS_AUTH0_CLIENT_ID: "test",
      CLAUDE_PLUGIN_DATA: dataDir,
    });
    expect(run.code, run.stderr).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr.split("\n")).toContain(`DIKIGOROS_BASE_URL must be one of ${ALLOWED_ORIGINS.join(", ")}`);
  });

  it("--extract-check counts the two-page fixture's pages, OCR pages and images on one stdout line", async () => {
    const pdf = join(tmp, "two-page.pdf");
    await writeFile(pdf, twoPagePdf());
    const run = await runBundle(["--extract-check", pdf], {
      DIKIGOROS_HELPER_NATIVE_DIR: join(ROOT, "node_modules"),
      CLAUDE_PLUGIN_DATA: dataDir,
    });
    // stderr may carry log lines; stdout is the one line of counts.
    expect(run.stdout, run.stderr).toBe('{"pages":2,"needsOcr":1,"images":1}\n');
    expect(run.code, run.stderr).toBe(0);
  });
});
