// extractPdf on the real pdf.js (legacy build, fake worker) and the real @napi-rs/canvas from the
// dev dependencies, with the hand-written PDFs of test/support/pdf-fixtures.ts.

import type * as NapiCanvas from "@napi-rs/canvas";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { blankPdf, imagePdf, pathPdf, textPdf, twoPagePdf } from "../../test/support/pdf-fixtures";
import type { CanvasLike, CanvasModule } from "../native/load";
import { createCanvasFactory, extractPdf, type PdfAssets } from "./pdf";

const require = createRequire(import.meta.url);
const napi = require("@napi-rs/canvas") as typeof NapiCanvas;
const fsPromises = require("node:fs/promises") as typeof import("node:fs/promises");
// The module's constructors behind stand-ins of their own identity. Here pdf.js's own require of
// @napi-rs/canvas works (in the bundle it does not) and would install napi's constructors itself,
// so only the stand-ins show that extractPdf installed the module's.
const canvas: CanvasModule = {
  ...napi,
  DOMMatrix: new Proxy(napi.DOMMatrix, {}),
  Path2D: new Proxy(napi.Path2D, {}),
  ImageData: new Proxy(napi.ImageData, {}),
};
const pdfjsDir = dirname(require.resolve("pdfjs-dist/package.json"));
const assets: PdfAssets = {
  workerSrc: pathToFileURL(join(pdfjsDir, "legacy", "build", "pdf.worker.min.mjs")).href,
  wasmUrl: `${join(pdfjsDir, "wasm")}/`,
  standardFontDataUrl: `${join(pdfjsDir, "standard_fonts")}/`,
};

const LEASE = ["The tenant shall vacate the premises", "within thirty days of the notice."];

describe("extractPdf", () => {
  it("reads the text layer of a text page and asks no OCR for it", async () => {
    const { pages, images } = await extractPdf(textPdf(LEASE), { canvas, assets });
    expect(pages).toEqual([
      { page: 1, text: "The tenant shall vacate the premises within thirty days of the notice.", needsOcr: false },
    ]);
    expect(images.size).toBe(0);
  });

  it("renders a scanned page 1600 px wide and keeps it as a JPEG for OCR", async () => {
    const { pages, images } = await extractPdf(imagePdf({ ink: true }), { canvas, assets });
    expect(pages).toEqual([{ page: 1, text: "", needsOcr: true }]);
    expect([...images.keys()]).toEqual([1]);
    const jpeg = images.get(1)!;
    expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
    expect(jpeg.length).toBeGreaterThan(2048);

    // Decoded, it is the 200 pt page at 8×: white margins around the black square in the middle.
    const picture = await napi.loadImage(jpeg);
    expect([picture.width, picture.height]).toEqual([1600, 1600]);
    const context = napi.createCanvas(1600, 1600).getContext("2d");
    context.drawImage(picture, 0, 0);
    const gray = (x: number, y: number) => context.getImageData(x, y, 1, 1).data[0];
    expect(gray(200, 200)).toBeGreaterThan(240);
    expect(gray(800, 800)).toBeLessThan(15);
  });

  it("renders a page whose text layer is too thin to trust, its glyphs drawn from the standard fonts", async () => {
    const readFile = vi.spyOn(fsPromises, "readFile"); // how pdf.js reads the font data in Node
    try {
      const { pages, images } = await extractPdf(textPdf(["Exhibit A to the Statement of Claim"]), { canvas, assets });
      expect(pages).toEqual([{ page: 1, text: "Exhibit A to the Statement of Claim", needsOcr: true }]);
      expect([...images.keys()]).toEqual([1]);
      // Helvetica's data; without it pdf.js would fall back to a system font, silently.
      expect(readFile.mock.calls.map(([path]) => String(path))).toContain(
        `${assets.standardFontDataUrl}LiberationSans-Regular.ttf`,
      );
    } finally {
      readFile.mockRestore();
    }
  });

  it("renders a page that only strokes a path", async () => {
    const { pages, images } = await extractPdf(pathPdf(), { canvas, assets });
    expect(pages).toEqual([{ page: 1, text: "", needsOcr: true }]);
    expect([...images.keys()]).toEqual([1]);
    const jpeg = images.get(1)!;
    expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
  });

  it("gives pdf.js the canvas module's DOMMatrix, Path2D and ImageData as globals", async () => {
    await extractPdf(blankPdf(), { canvas, assets });
    const globals = globalThis as Record<string, unknown>;
    expect(globals.DOMMatrix).toBe(canvas.DOMMatrix);
    expect(globals.Path2D).toBe(canvas.Path2D);
    expect(globals.ImageData).toBe(canvas.ImageData);
  });

  it("keeps no image of a blank page, which still needs OCR", async () => {
    const { pages, images } = await extractPdf(blankPdf(), { canvas, assets });
    expect(pages).toEqual([{ page: 1, text: "", needsOcr: true }]);
    expect(images.size).toBe(0);
  });

  it("keeps no image of a scanned white sheet", async () => {
    const { pages, images } = await extractPdf(imagePdf({ ink: false }), { canvas, assets });
    expect(pages).toEqual([{ page: 1, text: "", needsOcr: true }]);
    expect(images.size).toBe(0);
  });

  it("reports progress after each page", async () => {
    const onProgress = vi.fn();
    const { pages, images } = await extractPdf(twoPagePdf(), { canvas, assets, onProgress });
    expect(onProgress.mock.calls).toEqual([
      [1, 2],
      [2, 2],
    ]);
    expect(pages.map(({ page, needsOcr }) => ({ page, needsOcr }))).toEqual([
      { page: 1, needsOcr: false },
      { page: 2, needsOcr: true },
    ]);
    expect([...images.keys()]).toEqual([2]);
  });

  it("makes every canvas, pdf.js's own included, with the canvas module it is given", async () => {
    const sizes: number[][] = [];
    const recording: CanvasModule = {
      ...canvas,
      createCanvas: (width, height) => {
        sizes.push([width, height]);
        return canvas.createCanvas(width, height);
      },
    };
    await extractPdf(imagePdf({ ink: true }), { canvas: recording, assets });
    expect(sizes).toContainEqual([1600, 1600]); // the page
    expect(sizes).toContainEqual([200, 200]); // pdf.js's canvas for the scan's own pixels
  });

  it("reads a copy of the bytes: the caller's array stays whole and a Node Buffer is accepted", async () => {
    const bytes = textPdf(LEASE);
    const length = bytes.byteLength;
    await extractPdf(bytes, { canvas, assets });
    expect(bytes.byteLength).toBe(length);

    const { pages } = await extractPdf(Buffer.from(bytes), { canvas, assets });
    expect(pages[0].needsOcr).toBe(false);
  });

  it("rejects bytes that are not a PDF, printing nothing", async () => {
    const printed = [vi.spyOn(console, "log"), vi.spyOn(console, "warn")];
    try {
      await expect(extractPdf(new TextEncoder().encode("not a pdf"), { canvas, assets })).rejects.toThrow(
        "Invalid PDF structure",
      );
      // At its default verbosity pdf.js would warn "Indexing all PDF objects" before giving up.
      for (const spy of printed) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of printed) spy.mockRestore();
    }
  });
});

describe("createCanvasFactory", () => {
  const CanvasFactory = createCanvasFactory(canvas);

  it("creates a canvas with its 2D context, refusing a size that is not positive", () => {
    const factory = new CanvasFactory();
    expect(() => factory.create(0, 0)).toThrow("Invalid canvas size");
    expect(() => factory.create(10, -1)).toThrow("Invalid canvas size");
    const created = factory.create(30, 20);
    expect([created.canvas.width, created.canvas.height]).toEqual([30, 20]);
    expect(created.context.getImageData(0, 0, 30, 20).data).toHaveLength(30 * 20 * 4);
  });

  it("resizes on reset, zeroes and lets go on destroy, and refuses a missing canvas", () => {
    const factory = new CanvasFactory({ enableHWA: true });
    const created = factory.create(30, 20);
    factory.reset(created, 40, 50);
    expect([created.canvas.width, created.canvas.height]).toEqual([40, 50]);
    expect(() => factory.reset(created, 40, 0)).toThrow("Invalid canvas size");

    // A stand-in, because @napi-rs/canvas turns a zero width or height into its default size.
    const drawn = { width: 40, height: 50 } as CanvasLike;
    const entry: { canvas: CanvasLike | null; context: unknown } = { canvas: drawn, context: {} };
    factory.destroy(entry);
    expect([drawn.width, drawn.height]).toEqual([0, 0]);
    expect(entry).toEqual({ canvas: null, context: null });
    expect(() => factory.reset(entry, 40, 50)).toThrow("Canvas is not specified");
    expect(() => factory.destroy(entry)).toThrow("Canvas is not specified");
  });
});
