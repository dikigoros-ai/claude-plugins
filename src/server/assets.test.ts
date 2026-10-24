import { describe, expect, it } from "vitest";
import { resolveAssets } from "./assets";

describe("resolveAssets", () => {
  it("finds the worker, the wasm decoders and the standard fonts beside the bundle", () => {
    expect(resolveAssets("file:///x/server/dikigoros-upload.mjs")).toStrictEqual({
      workerSrc: "file:///x/server/pdf.worker.min.mjs",
      wasmUrl: "/x/server/wasm/",
      standardFontDataUrl: "/x/server/standard_fonts/",
    });
  });

  it("keeps the worker a URL and makes the two directories plain paths, decoded", () => {
    // import.meta.url of a plugin installed under a home folder with a Greek name and a space.
    const bundleUrl = "file:///Users/%CE%95%CE%BB%CE%AD%CE%BD%CE%B7/Claude%20Plugins/server/dikigoros-upload.mjs";
    expect(resolveAssets(bundleUrl)).toStrictEqual({
      workerSrc: "file:///Users/%CE%95%CE%BB%CE%AD%CE%BD%CE%B7/Claude%20Plugins/server/pdf.worker.min.mjs",
      wasmUrl: "/Users/Ελένη/Claude Plugins/server/wasm/",
      standardFontDataUrl: "/Users/Ελένη/Claude Plugins/server/standard_fonts/",
    });
  });
});
