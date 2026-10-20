// Builds the plugin's local server: src/server/main.ts and its dependencies bundled into one ES
// module at plugins/dikigoros/server/dikigoros-upload.mjs, the licence comments esbuild finds in
// the bundled code beside it, and the files pdf.js loads at runtime (its worker, wasm decoders and
// standard fonts) copied from pdfjs-dist to where src/server/assets.ts looks for them. The output
// is committed and CI rebuilds it, failing on any difference, so the same inputs must give the
// same bytes. The two native packages stay out of the bundle: it installs them on first use and
// loads them from there (src/native), never from its own directory.

import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_DIR = join(ROOT, "plugins", "dikigoros");
const SERVER_DIR = join(PLUGIN_DIR, "server");
const PDFJS_DIR = join(ROOT, "node_modules", "pdfjs-dist");
/** The decoders pdf.js loads from wasmUrl: JBIG2, JPEG 2000 and colour management. */
const WASM_DECODERS = ["jbig2.wasm", "openjpeg.wasm", "qcms_bg.wasm"];

const manifest = JSON.parse(await readFile(join(PLUGIN_DIR, ".claude-plugin", "plugin.json"), "utf8")) as {
  version: string;
};

// Everything in server/ is generated: it starts empty, so a file the build no longer makes is gone.
await rm(SERVER_DIR, { recursive: true, force: true });

await build({
  absWorkingDir: ROOT,
  entryPoints: ["src/server/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "plugins/dikigoros/server/dikigoros-upload.mjs",
  minify: true,
  legalComments: "external",
  external: ["@napi-rs/canvas", "@napi-rs/keyring"],
  define: { "process.env.NODE_ENV": '"production"', PLUGIN_VERSION: JSON.stringify(manifest.version) },
  // The CommonJS code in the bundle calls require, which an ES module does not have.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});

// pdf.js imports its worker from workerSrc and reads the decoders and the fonts by path. Left out of
// wasm/: the JavaScript fallbacks, for engines without WebAssembly, and the sandbox for PDF scripts.
const wasmLicences = (await readdir(join(PDFJS_DIR, "wasm"))).filter((name) => name.startsWith("LICENSE_"));
const fonts = await readdir(join(PDFJS_DIR, "standard_fonts"));
await copyFiles(join(PDFJS_DIR, "legacy", "build"), SERVER_DIR, ["pdf.worker.min.mjs"]);
await copyFiles(join(PDFJS_DIR, "wasm"), join(SERVER_DIR, "wasm"), [...WASM_DECODERS, ...wasmLicences]);
await copyFiles(join(PDFJS_DIR, "standard_fonts"), join(SERVER_DIR, "standard_fonts"), fonts);

/** Copies the files `names` of directory `from` into directory `to`, made when missing. */
async function copyFiles(from: string, to: string, names: string[]): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const name of names) await copyFile(join(from, name), join(to, name));
  console.log(`  copied ${names.length} file(s) from ${relative(ROOT, from)} to ${relative(ROOT, to)}`);
}
