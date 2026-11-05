// A local look at the project picker as a host shows it, run by hand before a release
// (docs/release-process.md), not in CI: the built plugins/dikigoros/server/ui/project-picker.html
// in a sandboxed iframe of a small host page, with a real AppBridge (@modelcontextprotocol/ext-apps)
// answering load_picker with test/support/picker-fixture.ts and save_selection with a stub, and
// screenshots in Chromium and WebKit, 375 and 768 px wide, English and Greek, light and dark, new
// matter and linked folder, into ui-harness-out/ (gitignored).
//
//   npm run build && npx tsx scripts/ui-harness.ts
//
// It needs Playwright with its Chromium and WebKit browsers, which the repository does not depend on:
// `npm i --no-save playwright && npx playwright install chromium webkit` once, or a machine that has
// them (PLAYWRIGHT_CHROMIUM_EXECUTABLE names a Chromium binary to use instead of Playwright's own).

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "ui-harness-out");
const PICKER = join(ROOT, "plugins", "dikigoros", "server", "ui", "project-picker.html");

/** The host page's script: the AppBridge side, bundled for the browser. */
const HOST_SOURCE = `
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { pickerInput, linkedInput } from "./test/support/picker-fixture";

const params = new URLSearchParams(location.search);
const input = params.get("mode") === "linked" ? linkedInput() : pickerInput();
const iframe = document.getElementById("app");
iframe.srcdoc = window.PICKER_HTML;
await new Promise((resolve) => iframe.addEventListener("load", resolve, { once: true }));
const bridge = new AppBridge(
  null,
  { name: "ui-harness", version: "1.0.0" },
  { serverTools: {}, message: { text: {} } },
  { hostContext: { theme: params.get("theme") ?? "light", locale: params.get("locale") ?? "en-GB" } },
);
bridge.oncalltool = async ({ name }) => {
  if (name === "load_picker") return { content: [{ type: "text", text: "tree" }], structuredContent: input };
  if (name === "save_selection") {
    return { content: [{ type: "text", text: "saved" }], structuredContent: { selection_id: "sel-1", digest: "0123456789abcdef", count: 12, total_bytes: 1 } };
  }
  return { isError: true, content: [{ type: "text", text: "no stub" }] };
};
bridge.onmessage = async () => ({});
bridge.onsizechange = ({ height }) => { if (height) iframe.style.height = height + "px"; };
const ready = new Promise((resolve) => { bridge.oninitialized = resolve; });
await bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow));
await ready;
await bridge.sendToolResult({
  content: [{ type: "text", text: "The picker is open." }],
  structuredContent: { status: "picker_open", scan_id: input.scan_id, mode: input.mode, room: input.room, eligible: 64, preselected: 12 },
});
document.body.dataset.ready = "1";
`;

type BrowserName = "chromium" | "webkit";

/** The part of Playwright the harness drives; typed here, as Playwright is not a dependency. */
interface Tab {
  goto(url: string): Promise<unknown>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(options: { path: string; fullPage: boolean }): Promise<unknown>;
}
interface Browser {
  newContext(options: { viewport: { width: number; height: number }; colorScheme: "light" | "dark" }): Promise<{
    newPage(): Promise<Tab>;
    close(): Promise<void>;
  }>;
  close(): Promise<void>;
}
type Playwright = Record<BrowserName, { launch(options: { executablePath?: string }): Promise<Browser> }>;

async function main(): Promise<void> {
  const html = await readFile(PICKER, "utf8").catch(() => {
    throw new Error(`no ${PICKER}: run npm run build first`);
  });
  const bundled = await build({
    stdin: { contents: HOST_SOURCE, resolveDir: ROOT, loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0}iframe{border:0;width:100%;height:900px;display:block}</style></head>
<body><iframe id="app" sandbox="allow-scripts"></iframe>
<script>window.PICKER_HTML = ${JSON.stringify(html).replace(/<\//g, "<\\/")};</script>
<script type="module">${bundled.outputFiles[0].text.replace(/<\/(script)/gi, "<\\/$1")}</script></body></html>`;
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const hostFile = join(OUT, "host.html");
  await writeFile(hostFile, page);

  const module = "playwright";
  // An ES import does not search NODE_PATH, where a machine-wide Playwright often is; require does.
  const playwright = (await import(module).catch(() => {
    try {
      return createRequire(import.meta.url)(module);
    } catch {
      throw new Error("Playwright is not installed: npm i --no-save playwright && npx playwright install chromium webkit");
    }
  })) as Playwright;
  const shots: string[] = [];
  const missing: string[] = [];
  for (const name of ["chromium", "webkit"] as BrowserName[]) {
    const executablePath = name === "chromium" ? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE : undefined;
    let browser: Browser;
    try {
      browser = await playwright[name].launch(executablePath === undefined ? {} : { executablePath });
    } catch (err) {
      // A release needs both engines (iPhones are WebKit): say so loudly, but still show the other one.
      missing.push(`${name}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      continue;
    }
    try {
      for (const width of [375, 768]) {
        for (const locale of ["en-GB", "el-CY"]) {
          for (const theme of ["light", "dark"]) {
            for (const mode of ["new", "linked"]) {
              const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme as "light" | "dark" });
              const tab = await context.newPage();
              const query = new URLSearchParams({ locale, theme, mode }).toString();
              await tab.goto(`file://${hostFile}?${query}`);
              await tab.waitForSelector("body[data-ready='1']", { timeout: 15_000 });
              await tab.waitForTimeout(300);
              const file = join(OUT, `${name}-${width}-${locale}-${theme}-${mode}.png`);
              await tab.screenshot({ path: file, fullPage: true });
              shots.push(file);
              await context.close();
            }
          }
        }
      }
    } finally {
      await browser.close();
    }
  }
  console.log(`wrote ${shots.length} screenshot(s) to ${OUT}`);
  for (const line of missing) console.error(`NOT RUN — ${line}`);
  if (missing.length > 0) process.exitCode = 1;
}

await main();
