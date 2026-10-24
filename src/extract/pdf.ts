// PDF extraction in Node, ported from extractPdf in dikigoros-ai/dikigoros-ai lib/matter-extract.ts
// @ 37f39ac5 (2026-10-19): pdf.js reads each page's text layer, and a page without usable text is
// rendered 1600 px wide (smaller for a page so tall that the image would pass MAX_RASTER_PIXELS) and
// kept as a JPEG for OCR, unless the render is a blank sheet. The canvas module is passed in because
// it is installed on first use (src/native). pdf.js looks for @napi-rs/canvas beside its own file,
// which in the bundle is not there, so it gets the module's canvases through a factory, and the
// module's constructors as globals set before it is imported.

import type * as Pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { CanvasContextLike, CanvasLike, CanvasModule } from "../native/load";
import { classifyPage, isBlankRaster, joinPdfTextItems } from "./classify";

export interface PdfAssets {
  /** file:// URL of pdf.worker.min.mjs, which pdf.js imports to run its worker in this thread. */
  workerSrc: string;
  /** Directory of pdf.js's wasm decoders (JBIG2, JPEG 2000, colour management), ending in "/". */
  wasmUrl: string;
  /** Directory of the standard font data, ending in "/". */
  standardFontDataUrl: string;
}

export interface ExtractedPdf {
  pages: { page: number; text: string; needsOcr: boolean }[];
  /** The JPEG of each page that needs OCR, by page number; a page that rendered blank has none. */
  images: Map<number, Uint8Array>;
}

type CanvasFactoryClass = new (opts?: { enableHWA?: boolean }) => {
  create(w: number, h: number): { canvas: CanvasLike; context: CanvasContextLike };
  reset(c: { canvas: CanvasLike | null }, w: number, h: number): void;
  destroy(c: { canvas: CanvasLike | null; context: unknown }): void;
};

const OCR_WIDTH_PX = 1600;
const JPEG_QUALITY = 80; // of 100; the browser encodes at 0.8

/**
 * The most pixels a page is rendered with: 100 MB of canvas. A page tall and narrow enough that
 * 1600 px wide would pass it (a PDF page may be 14,400 pt long) is rendered smaller, the same shape.
 */
export const MAX_RASTER_PIXELS = 25_000_000;

let pdfjsLoaded: Promise<typeof Pdfjs> | undefined;

/**
 * pdf.js, imported on first use. At import it polyfills DOMMatrix and Path2D by requiring
 * @napi-rs/canvas from beside its own file; in the bundle that fails, and a page that draws a path
 * then throws "Path2D is not defined". So the canvas module's constructors are installed first.
 */
function loadPdfjs(canvas: CanvasModule): Promise<typeof Pdfjs> {
  if (!pdfjsLoaded) {
    const globals = globalThis as Record<string, unknown>;
    globals.DOMMatrix ??= canvas.DOMMatrix;
    globals.Path2D ??= canvas.Path2D;
    globals.ImageData ??= canvas.ImageData;
    pdfjsLoaded = import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return pdfjsLoaded;
}

/** pdf.js's BaseCanvasFactory, making its canvases with the given module. */
export function createCanvasFactory(canvas: CanvasModule): CanvasFactoryClass {
  return class CanvasFactory {
    readonly #enableHWA: boolean;

    constructor({ enableHWA = false }: { enableHWA?: boolean } = {}) {
      this.#enableHWA = enableHWA;
    }

    create(width: number, height: number): { canvas: CanvasLike; context: CanvasContextLike } {
      if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
      const created = canvas.createCanvas(width, height);
      return { canvas: created, context: created.getContext("2d", { willReadFrequently: !this.#enableHWA }) };
    }

    reset({ canvas: target }: { canvas: CanvasLike | null }, width: number, height: number): void {
      if (!target) throw new Error("Canvas is not specified");
      if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
      target.width = width;
      target.height = height;
    }

    destroy(canvasAndContext: { canvas: CanvasLike | null; context: unknown }): void {
      const target = canvasAndContext.canvas;
      if (!target) throw new Error("Canvas is not specified");
      target.width = target.height = 0;
      canvasAndContext.canvas = null;
      canvasAndContext.context = null;
    }
  };
}

export async function extractPdf(
  bytes: Uint8Array,
  opts: { canvas: CanvasModule; assets: PdfAssets; onProgress?: (page: number, total: number) => void },
): Promise<ExtractedPdf> {
  const { assets, onProgress } = opts;
  const pdfjs = await loadPdfjs(opts.canvas);
  // pdf.js imports the worker module at the first getDocument and keeps it for the process.
  pdfjs.GlobalWorkerOptions.workerSrc = assets.workerSrc;
  const CanvasFactory = createCanvasFactory(opts.canvas);
  const task = pdfjs.getDocument({
    // A copy, as a plain Uint8Array: pdf.js takes over the buffer it is given (it is detached),
    // and it refuses a Node Buffer, which is what fs.readFile returns.
    data: new Uint8Array(bytes),
    wasmUrl: assets.wasmUrl,
    standardFontDataUrl: assets.standardFontDataUrl,
    CanvasFactory,
    // Errors only, here and in the worker: pdf.js warns about every flaw it works around (a
    // repaired xref, a font fallback). An image it cannot decode (its wasm decoder missing, for one)
    // is such a warning, not a rejection: the page then renders blank and the blank check drops its
    // image without a word, which is why the tests and the smoke test decode a CCITT scan.
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  try {
    const doc = await task.promise;
    const factory = new CanvasFactory();
    const pages: ExtractedPdf["pages"] = [];
    const images = new Map<number, Uint8Array>();
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = joinPdfTextItems(
        content.items.filter(
          (it): it is Extract<(typeof content.items)[number], { str: string }> => "str" in it,
        ),
      );
      const { needsOcr } = classifyPage(text);
      if (needsOcr) {
        const jpeg = await rasterise(page, factory);
        if (jpeg) images.set(n, jpeg);
      }
      // pdf.js keeps a rendered page's decoded images until the page is cleaned up: about 50 MB
      // for an A4 scan at 300 dpi, so a long scanned bundle would otherwise exhaust memory.
      page.cleanup();
      pages.push({ page: n, text, needsOcr });
      onProgress?.(n, doc.numPages);
    }
    return { pages, images };
  } finally {
    // Ends the document and its worker, also when the bytes did not open as a PDF.
    await task.destroy();
  }
}

/**
 * The page rendered 1600 px wide as a JPEG, or at most MAX_RASTER_PIXELS large, the same shape; null
 * when it rendered as an empty sheet.
 */
async function rasterise(
  page: PDFPageProxy,
  factory: InstanceType<CanvasFactoryClass>,
): Promise<Uint8Array | null> {
  const { width, height } = page.getViewport({ scale: 1 });
  let scale = OCR_WIDTH_PX / width;
  if (width * scale * (height * scale) > MAX_RASTER_PIXELS) scale = Math.sqrt(MAX_RASTER_PIXELS / (width * height));
  const viewport = page.getViewport({ scale });
  // Rounded down, so that the canvas stays within MAX_RASTER_PIXELS.
  const target = factory.create(Math.floor(viewport.width), Math.floor(viewport.height));
  try {
    const { canvas, context } = target;
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;
    // An empty sheet gets no image: there is nothing to OCR, and a vision model asked to
    // transcribe one answers with a sentence about it.
    if (isBlankRaster(context.getImageData(0, 0, canvas.width, canvas.height).data)) return null;
    return await canvas.encode("jpeg", JPEG_QUALITY);
  } finally {
    factory.destroy(target);
  }
}
