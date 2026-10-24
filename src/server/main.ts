// The dikigoros-upload MCP server: JSON-RPC over stdio to the plugin's host, its two tools (./tools)
// over the sign-in (../auth), the REST client (../api) and the document pipeline (../pipeline). The
// native packages, canvas for scanned pages and keyring for the OS keychain, are installed on first
// use into the plugin's data directory, unless DIKIGOROS_HELPER_NATIVE_DIR names a node_modules that
// holds them. `node dikigoros-upload.mjs --extract-check <file>` starts no server: it extracts the
// PDF and prints its counts, a check that pdf.js and the canvas work from the bundle's directory. A
// Node.js older than 22.13 gets one stderr line and exit 1 before anything else.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { uploadBlob } from "../api/blob-upload";
import { DikigorosApi } from "../api/client";
import { openBrowser } from "../auth/open-browser";
import { AuthSession } from "../auth/session";
import { createTokenStore } from "../auth/token-store";
import { ConfigError, type HelperConfig, loadConfig } from "../config";
import { extractDocx } from "../extract/docx";
import { extractPdf } from "../extract/pdf";
import { resolveUploadPlan } from "../files/resolve";
import { ensureNativeRuntime, readNativeLock } from "../native/install";
import { loadCanvasModule, loadKeyringBinding } from "../native/load";
import lock from "../native/lock.generated.json" with { type: "json" };
import { platformKey } from "../native/platform";
import { uploadDocument, type UploadDeps } from "../pipeline/upload-document";
import { resolveAssets } from "./assets";
import { once } from "./lazy";
import { isSupportedNode } from "./node-version";
import { registerTools, type ToolDeps } from "./tools";

/** The plugin's version, defined by the build (scripts/build.ts); not defined when run from source. */
declare const PLUGIN_VERSION: string | undefined;

/**
 * The blob SDK's settings of where it sends an upload. The helper's store is the SDK's default; an
 * inherited value would send the files' bytes and their client tokens somewhere else.
 */
const BLOB_DESTINATION_VARIABLES = [
  "VERCEL_BLOB_API_URL",
  "NEXT_PUBLIC_VERCEL_BLOB_API_URL",
  "VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API",
  "NEXT_PUBLIC_VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API",
];

if (!isSupportedNode(process.versions.node)) {
  console.error(`dikigoros-upload needs Node.js 22.13 or later; found ${process.versions.node}`);
  process.exit(1);
}
// stdout is the JSON-RPC channel: whatever a library prints goes to stderr instead.
console.log = console.info = console.warn = console.debug = console.dir = console.error;
// The SDK reads them at each upload, so they are gone before the first.
for (const name of BLOB_DESTINATION_VARIABLES) delete process.env[name];
// The blob SDK retries a failed upload 10 times by default, doubling its wait: half an hour of silence.
process.env.VERCEL_BLOB_RETRIES ||= "2";

const log = (line: string) => console.error(`[dikigoros-upload] ${line}`);
const config = loadConfigOrExit();
const assets = resolveAssets(import.meta.url);

/** The node_modules holding the native packages, found or installed on first use; a failed install is tried again. */
const runtime = once(async () => {
  if (config.nativeDirOverride !== null) return { nodeModulesDir: config.nativeDirOverride };
  const platform = platformKey(process.platform, process.arch);
  return ensureNativeRuntime({ dataDir: config.dataDir, lock: readNativeLock(lock), platform, fetchImpl: fetch, log });
});
const store = once(() => createTokenStore(async () => loadKeyringBinding((await runtime()).nodeModulesDir)));
const extract: UploadDeps["extractPdf"] = async (bytes, onProgress) =>
  extractPdf(bytes, { canvas: loadCanvasModule((await runtime()).nodeModulesDir), assets, onProgress });

if (process.argv[2] === "--extract-check") {
  await extractCheck(process.argv[3]);
} else {
  serve();
}

/** The configuration; a DIKIGOROS_BASE_URL other than the allowed origins is one stderr line and exit 1. */
function loadConfigOrExit(): HelperConfig {
  try {
    return loadConfig(process.env, homedir());
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(err.message);
    process.exit(1);
  }
}

/** One JSON line on stdout, the PDF's pages, those that need OCR and their images, then exit 0; 2 on any failure. */
async function extractCheck(file: string | undefined): Promise<void> {
  try {
    if (file === undefined) throw new Error("--extract-check needs the path of a PDF");
    const { pages, images } = await extract(await readFile(file));
    const counts = { pages: pages.length, needsOcr: pages.filter((page) => page.needsOcr).length, images: images.size };
    // Written to the stream itself, console.log being stderr now; the exit waits until it is out.
    process.stdout.write(`${JSON.stringify(counts)}\n`, () => process.exit(0));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}

/** The MCP server on stdin and stdout, its tools answering with the session, the API and the pipeline. */
function serve(): void {
  const session = new AuthSession({
    config,
    store: () => store().then((created) => created.store),
    fetchImpl: fetch,
    sleep,
    now: Date.now,
    openBrowser: config.openBrowser ? openBrowser : () => {},
    log,
  });
  const api = new DikigorosApi({
    baseUrl: config.baseUrl,
    getToken: () => session.getAccessToken(),
    onUnauthorized: async () => {
      session.invalidateAccessToken();
      return session.getAccessToken();
    },
    fetchImpl: fetch,
  });
  const pipeline: UploadDeps = {
    api,
    uploadBlob,
    extractPdf: extract,
    extractDocx,
    readFile: (path) => readFile(path),
    sleep,
    now: Date.now,
    log,
  };
  const deps: ToolDeps = {
    config,
    session,
    api,
    resolvePlan: resolveUploadPlan,
    upload: (entry, ctx, onProgress) => uploadDocument(entry, ctx, { ...pipeline, onProgress }),
    nativeRuntime: runtime,
    tokenStoreWarning: async () => (await store()).warning,
    now: Date.now,
  };
  const version = typeof PLUGIN_VERSION === "string" ? PLUGIN_VERSION : "dev";
  serveStdio(() => {
    const server = new McpServer({ name: "dikigoros-upload", version });
    registerTools(server, deps);
    return server;
  });
}
