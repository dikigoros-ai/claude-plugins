// Builds the plugin's local server: src/server/main.ts and its dependencies bundled into one ES
// module at plugins/dikigoros/server/dikigoros-upload.mjs, the licence comments esbuild finds in
// the bundled code beside it, the files pdf.js loads at runtime (its worker, wasm decoders and
// standard fonts) copied from pdfjs-dist to where src/server/assets.ts looks for them, and
// THIRD_PARTY_NOTICES.md: pdf.js's own notice, then the licence of every package the bundle holds
// code of. The output is committed and CI rebuilds it, failing on any difference, so the same inputs
// must give the same bytes. The two native packages stay out of the bundle: it installs them on
// first use and loads them from there (src/native), never from its own directory.

import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Metafile } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_DIR = join(ROOT, "plugins", "dikigoros");
const SERVER_DIR = join(PLUGIN_DIR, "server");
const PDFJS_DIR = join(ROOT, "node_modules", "pdfjs-dist");
/** The decoders pdf.js loads from wasmUrl: JBIG2, JPEG 2000 and colour management. */
const WASM_DECODERS = ["jbig2.wasm", "openjpeg.wasm", "qcms_bg.wasm"];
/** A package's licence file: the first of these, by name, in its directory. */
const LICENCE_FILE = /^(LICEN[CS]E|COPYING)/i;

const manifest = JSON.parse(await readFile(join(PLUGIN_DIR, ".claude-plugin", "plugin.json"), "utf8")) as {
  version: string;
};

// Everything in server/ is generated: it starts empty, so a file the build no longer makes is gone.
await rm(SERVER_DIR, { recursive: true, force: true });

const { metafile } = await build({
  absWorkingDir: ROOT,
  entryPoints: ["src/server/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "plugins/dikigoros/server/dikigoros-upload.mjs",
  minify: true,
  legalComments: "external",
  metafile: true,
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

const packages = await bundledPackages(metafile);
await writeFile(join(SERVER_DIR, "THIRD_PARTY_NOTICES.md"), await notices(packages));
console.log(`  wrote the notices of ${packages.length} package(s) to ${relative(ROOT, SERVER_DIR)}/THIRD_PARTY_NOTICES.md`);

/** Copies the files `names` of directory `from` into directory `to`, made when missing. */
async function copyFiles(from: string, to: string, names: string[]): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const name of names) await copyFile(join(from, name), join(to, name));
  console.log(`  copied ${names.length} file(s) from ${relative(ROOT, from)} to ${relative(ROOT, to)}`);
}

interface BundledPackage {
  /** name@version, from the package's own package.json. */
  id: string;
  /** Its package.json `license`; "unknown" when it names none. */
  licence: string;
  /** The text of its licence file; null when the package ships none. */
  text: string | null;
}

/**
 * Every package the bundle holds code of: the directory under the last node_modules of each input
 * esbuild bundled, read for its name, version, licence and licence file. One entry per name@version,
 * sorted by it.
 */
async function bundledPackages({ inputs }: Metafile): Promise<BundledPackage[]> {
  const directories = new Set<string>();
  for (const input of Object.keys(inputs)) {
    const parts = input.split("/");
    const at = parts.lastIndexOf("node_modules");
    if (at === -1) continue;
    const scoped = parts[at + 1].startsWith("@");
    directories.add(parts.slice(0, at + (scoped ? 3 : 2)).join("/"));
  }
  const found = new Map<string, BundledPackage>();
  for (const directory of [...directories].sort()) {
    const json = JSON.parse(await readFile(join(ROOT, directory, "package.json"), "utf8")) as {
      name: string;
      version: string;
      license?: unknown;
    };
    const id = `${json.name}@${json.version}`;
    if (found.has(id)) continue;
    const licenceFile = (await readdir(join(ROOT, directory))).filter((name) => LICENCE_FILE.test(name)).sort()[0];
    const text = licenceFile === undefined ? null : await readFile(join(ROOT, directory, licenceFile), "utf8");
    found.set(id, { id, licence: licenceOf(json.license), text });
  }
  return [...found.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A package.json `license`: an SPDX expression, or the `type` of an old-style object. */
function licenceOf(license: unknown): string {
  if (typeof license === "string" && license !== "") return license;
  if (typeof license === "object" && license !== null && typeof (license as { type?: unknown }).type === "string") {
    return (license as { type: string }).type;
  }
  return "unknown";
}

/**
 * The notices file: what it covers, pdf.js's own notice (the comment at the top of its files, which
 * the minified bundle drops), then a section per package with its licence text in a code fence.
 */
async function notices(bundled: BundledPackage[]): Promise<string> {
  const pdfjs = await readFile(join(PDFJS_DIR, "legacy", "build", "pdf.mjs"), "utf8");
  const end = pdfjs.indexOf("*/");
  if (!pdfjs.startsWith("/**") || end === -1 || !pdfjs.slice(0, end).includes("@licstart")) {
    throw new Error("pdfjs-dist/legacy/build/pdf.mjs no longer starts with its licence notice");
  }
  const lines = [
    "# Third-party notices",
    "",
    "Generated by `npm run build` (scripts/build.ts). `dikigoros-upload.mjs` holds code of the packages below.",
    "Beside it, `pdf.worker.min.mjs`, `wasm/` and `standard_fonts/` are files of pdfjs-dist as it ships them: the",
    "worker keeps its notice at its top, and the decoders and the fonts have their licences beside them",
    "(`LICENSE_*`).",
    "",
    "pdf.js's own notice, as its files carry it:",
    "",
    ...fenced(pdfjs.slice(0, end + 2)),
  ];
  for (const { id, licence, text } of bundled) {
    lines.push("", `## ${id} — ${licence}`, "");
    if (text === null) lines.push("licence text not shipped in the package");
    else lines.push(...fenced(text));
  }
  return `${lines.join("\n")}\n`;
}

/** `text` in a code fence longer than any run of backticks in it, its line ends LF, blank lines around it trimmed. */
function fenced(text: string): string[] {
  const body = text
    .replace(/\r\n?/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .trimEnd();
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [fence, body, fence];
}
