// Where pdf.js finds its worker, its wasm decoders and its standard fonts in the plugin: in the
// directory of the bundle, where the build copies them (scripts/build.ts).

import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PdfAssets } from "../extract/pdf";

/**
 * The assets beside the file at `bundleUrl`, the bundle's import.meta.url. The worker is a file://
 * URL, which pdf.js imports; wasm/ and standard_fonts/ are directory paths ending in "/", with
 * forward slashes on every platform, as pdf.js in Node appends a file name and reads it with fs.
 */
export function resolveAssets(bundleUrl: string): PdfAssets {
  const dir = dirname(fileURLToPath(bundleUrl));
  const directory = (name: string) => `${join(dir, name).split(sep).join("/")}/`;
  return {
    workerSrc: pathToFileURL(join(dir, "pdf.worker.min.mjs")).href,
    wasmUrl: directory("wasm"),
    standardFontDataUrl: directory("standard_fonts"),
  };
}
