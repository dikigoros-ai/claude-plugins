// Ported verbatim from dikigoros-ai/dikigoros-ai lib/matter-extract.ts @ 37f39ac5 (2026-10-19). Environment-neutral; sharing it as a package is a follow-up.

const MIN_TEXT_CHARS = 40; // below this a page is presumed scanned
const MIN_LETTER_RATIO = 0.5; // letters (incl. Greek) / non-space chars

export function classifyPage(text: string): { needsOcr: boolean } {
  const stripped = text.replace(/\s+/g, "");
  if (stripped.length < MIN_TEXT_CHARS) return { needsOcr: true };
  const letters = stripped.match(/[A-Za-zͰ-Ͽἀ-῿]/g)?.length ?? 0;
  return { needsOcr: letters / stripped.length < MIN_LETTER_RATIO };
}

/**
 * Minimal shape of a pdfjs `TextItem` we rely on. Declared locally (rather than
 * imported from pdfjs-dist's deep type path) so this helper stays pure and
 * unit-testable without pulling the library in.
 */
export interface PdfTextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
}

/** pdfjs transform = [a, b, c, d, x, y]; the font size is d (≈ height). */
function fontSizeOf(it: PdfTextItemLike): number {
  if (it.height > 0) return it.height;
  const d = Math.abs(it.transform?.[3] ?? 0);
  if (d > 0) return d;
  const a = Math.abs(it.transform?.[0] ?? 0);
  if (a > 0) return a;
  return 10;
}

/**
 * Join a page's text items by GEOMETRY rather than with a blanket space.
 *
 * Greek PDFs emit some glyphs (typically «μ») as their own text item when the
 * font run switches, so a plain `.join(" ")` produced «Νό μ ου» / «Εναγό μ ενης»
 * — both in the viewer's extracted text and in the chunks fed to retrieval,
 * where «Νόμου» then never matched lexically. Items that continue the same word
 * (same line, no horizontal gap) are concatenated with no separator; line ends
 * and real gaps still collapse to ONE space, so the page keeps the
 * one-paragraph-per-page shape `chunkPages`/`classifyPage` already assume.
 */
export function joinPdfTextItems(items: readonly PdfTextItemLike[]): string {
  let out = "";
  let prev: PdfTextItemLike | null = null;
  let pendingEol = false;

  for (const it of items) {
    // Empty items carry no text but can still carry the line break.
    if (!it.str) {
      if (it.hasEOL) pendingEol = true;
      continue;
    }
    if (prev === null) {
      out = it.str;
      prev = it;
      pendingEol = it.hasEOL;
      continue;
    }

    const size = fontSizeOf(prev);
    // The LINE test keys off the SMALLER of the two font sizes: a 30pt heading
    // followed by a 12pt line 12 units below is a new line for the 12pt text,
    // but half of 30 (15) would swallow the drop and the gap branch would then
    // concatenate («ΑΠΟΦΑΣΗΤο»). The GAP test stays on prev's own size — the
    // horizontal advance is the previous run's, not the next one's.
    const lineSize = Math.min(size, fontSizeOf(it));
    let separator: string;
    if (pendingEol) {
      separator = " ";
    } else if (Math.abs((it.transform?.[5] ?? 0) - (prev.transform?.[5] ?? 0)) > lineSize * 0.5) {
      separator = " "; // different line, even without an explicit EOL
    } else {
      const gap = (it.transform?.[4] ?? 0) - ((prev.transform?.[4] ?? 0) + prev.width);
      separator = gap > size * 0.15 || /\s$/.test(prev.str) || /^\s/.test(it.str) ? " " : "";
    }

    out += separator + it.str;
    prev = it;
    pendingEol = it.hasEOL;
  }

  return out.replace(/[ \t]+/g, " ").trim();
}

// Darker than this is ink. Deliberately generous: the check exists to catch a
// sheet nothing was drawn on (pure white), and a faded fax or light photocopy
// has strokes around luma 160–190 — when in doubt the page goes to OCR.
// Scanner shading on a blank sheet sits above 215.
const INK_LUMA_MAX = 200;
const BLANK_INK_FRACTION = 0.0002; // under 0.02% ink pixels, nothing was drawn

/**
 * Did the page render as an empty sheet? Takes the canvas's RGBA bytes
 * (`getImageData().data`). A page of text is around 4% ink and one short line
 * around 0.1%; a blank sheet with scanner specks stays far below the
 * threshold. An unpainted (transparent) pixel is not ink. pdfjs does not
 * reject `render()` when it cannot decode a page's image — it draws nothing —
 * so this is the only signal that there is nothing to OCR.
 */
export function isBlankRaster(rgba: Uint8ClampedArray | Uint8Array): boolean {
  const pixels = rgba.length >> 2;
  const limit = pixels * BLANK_INK_FRACTION;
  let ink = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    const luma = (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000;
    if (luma < INK_LUMA_MAX && ++ink > limit) return false;
  }
  return true;
}
