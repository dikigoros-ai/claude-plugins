// Cases ported verbatim from dikigoros-ai/dikigoros-ai lib/matter-extract.test.ts @ 37f39ac5 (2026-10-19), less its browser-only pdfDocumentOptions case.
import { describe, it, expect } from "vitest";
import { classifyPage, isBlankRaster, joinPdfTextItems, type PdfTextItemLike } from "./classify";

describe("classifyPage", () => {
  it("a page with real text does not need OCR", () => {
    expect(classifyPage("Η αγωγή αφορά σύμβαση πώλησης ακινήτου στη Λευκωσία. ".repeat(5)).needsOcr).toBe(false);
  });
  it("an image-only page (empty/near-empty text layer) needs OCR", () => {
    expect(classifyPage("").needsOcr).toBe(true);
    expect(classifyPage("  \n 3 \n ").needsOcr).toBe(true);
  });
  it("a scanner-artifact text layer (few glyphs, mostly symbols) needs OCR", () => {
    expect(classifyPage("| . _ ~ | . _ ~").needsOcr).toBe(true);
  });
});

// Greek PDFs emit some glyphs (typically μ) as their own text item when the font
// run switches. A plain space-join produced «Νό μ ου» / «Εναγό μ ενης» in the
// viewer's extracted text AND in the chunks fed to retrieval, so «Νόμου» never
// matched lexically. joinPdfTextItems() joins by geometry instead.
function item(
  str: string,
  x: number,
  width: number,
  opts: { y?: number; height?: number; hasEOL?: boolean } = {},
): PdfTextItemLike {
  const height = opts.height ?? 10;
  return {
    str,
    transform: [height, 0, 0, height, x, opts.y ?? 100],
    width,
    height,
    hasEOL: opts.hasEOL ?? false,
  };
}

describe("joinPdfTextItems", () => {
  it("joins an adjacent glyph run into one word (Νό|μ|ου)", () => {
    expect(
      joinPdfTextItems([item("Νό", 0, 20), item("μ", 20, 10), item("ου", 30, 20)]),
    ).toBe("Νόμου");
  });

  it("joins an adjacent glyph run mid-word (Εναγό|μ|ενης)", () => {
    expect(
      joinPdfTextItems([item("Εναγό", 0, 50), item("μ", 50, 10), item("ενης", 60, 40)]),
    ).toBe("Εναγόμενης");
  });

  it("keeps one space where there is a real horizontal gap", () => {
    expect(joinPdfTextItems([item("Αγωγή", 0, 50), item("αρ.", 53, 20)])).toBe("Αγωγή αρ.");
  });

  // The next item is on a NEW line, so the geometry branch alone would separate
  // these two: what this pins is that a line break plus a space-prefixed item
  // still collapses to exactly ONE space — not that hasEOL was honoured.
  it("collapses a new-line transition and a space-prefixed item to one space", () => {
    expect(
      joinPdfTextItems([item("Αγωγή", 0, 50, { hasEOL: true }), item(" αρ.", 0, 20, { y: 88 })]),
    ).toBe("Αγωγή αρ.");
  });

  it("skips an empty-str item between two lines without adding a separator", () => {
    expect(
      joinPdfTextItems([
        item("Α", 0, 10),
        item("", 10, 0, { hasEOL: true }),
        item("Β", 0, 10, { y: 88 }),
      ]),
    ).toBe("Α Β");
  });

  // Same-line EOL: the ONLY shape that pins the pendingEol machinery. Both
  // items sit on the same y with a zero gap, so geometry alone would
  // concatenate («ΑΒ») — the space can only come from the carried hasEOL.
  it("honours the hasEOL of a skipped empty-str item on the SAME line", () => {
    expect(
      joinPdfTextItems([
        item("Α", 0, 10),
        item("", 10, 0, { hasEOL: true }),
        item("Β", 10, 10),
      ]),
    ).toBe("Α Β");
  });

  it("honours an item's own hasEOL when the next item is adjacent on the SAME line", () => {
    expect(joinPdfTextItems([item("Α", 0, 10, { hasEOL: true }), item("Β", 10, 10)])).toBe("Α Β");
  });

  // A 30pt heading followed by a 12pt line only 12 units below: the line test
  // must key off the SMALLER of the two font sizes, or the 30pt half-height
  // (15) swallows the transition and the gap branch concatenates («ΑΠΟΦΑΣΗΤο»).
  it("separates a large heading from the smaller line beneath it (no hasEOL)", () => {
    expect(
      joinPdfTextItems([
        item("ΑΠΟΦΑΣΗ", 0, 140, { height: 30 }),
        item("Το", 0, 20, { height: 12, y: 88 }),
      ]),
    ).toBe("ΑΠΟΦΑΣΗ Το");
  });

  it("separates a new line detected by geometry alone (no hasEOL)", () => {
    expect(joinPdfTextItems([item("Α", 0, 10), item("Β", 0, 10, { y: 88 })])).toBe("Α Β");
  });

  it("leaves a normal single-item page unchanged apart from trimming", () => {
    expect(joinPdfTextItems([item("  ΣΤΟ ΕΠΑΡΧΙΑΚΟ ΔΙΚΑΣΤΗΡΙΟ  ", 0, 200)])).toBe(
      "ΣΤΟ ΕΠΑΡΧΙΑΚΟ ΔΙΚΑΣΤΗΡΙΟ",
    );
  });

  it("never produces two consecutive spaces", () => {
    const out = joinPdfTextItems([
      item("Αγωγή ", 0, 55),
      item(" αρ. ", 58, 25),
      item("112/2025", 85, 60, { hasEOL: true }),
      item(" δυνά", 0, 45, { y: 88 }),
      item("μ", 45, 10, { y: 88 }),
      item("ει ", 55, 20, { y: 88 }),
      item("του Νό", 78, 50, { y: 88 }),
      item("μ", 128, 10, { y: 88 }),
      item("ου", 138, 20, { y: 88 }),
    ]);
    expect(out).toBe("Αγωγή αρ. 112/2025 δυνάμει του Νόμου");
    expect(out).not.toMatch(/ {2}/);
  });
});

/** `pixels` RGBA pixels of `shade`, the first `ink` of them `inkShade`. */
function raster(pixels: number, ink: number, shade = 255, inkShade = 0): Uint8ClampedArray {
  const data = new Uint8ClampedArray(pixels * 4).fill(shade);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  for (let i = 0; i < ink; i++) {
    const o = i * 4;
    data[o] = data[o + 1] = data[o + 2] = inkShade;
  }
  return data;
}

describe("isBlankRaster", () => {
  it("an all-white page is blank", () => {
    expect(isBlankRaster(raster(100_000, 0))).toBe(true);
  });
  it("a page of text is not blank (4% ink — the measured figure for a gazette page)", () => {
    expect(isBlankRaster(raster(100_000, 4_000))).toBe(false);
  });
  it("a single line of text is not blank (0.1% ink)", () => {
    expect(isBlankRaster(raster(100_000, 100))).toBe(false);
  });
  it("faint text — a faded fax or light photocopy, strokes at luma 180 — is not blank", () => {
    expect(isBlankRaster(raster(100_000, 4_000, 255, 180))).toBe(false);
  });
  it("a few scanner specks are still blank (0.01% ink)", () => {
    expect(isBlankRaster(raster(100_000, 10))).toBe(true);
  });
  it("light grey scanner shading is not ink", () => {
    expect(isBlankRaster(raster(100_000, 0, 215))).toBe(true);
  });
  it("a canvas nothing was painted on (fully transparent) is blank", () => {
    expect(isBlankRaster(new Uint8ClampedArray(400))).toBe(true);
  });
  it("an empty buffer is blank", () => {
    expect(isBlankRaster(new Uint8ClampedArray(0))).toBe(true);
  });
});
