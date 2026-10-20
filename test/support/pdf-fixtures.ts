// Minimal valid PDFs, written by hand for the PDF extraction tests. The objects are laid out in
// order, each one's byte offset goes into the xref table and the trailer points at that table, so
// pdf.js opens the files as they are rather than through its repair pass (which prints a warning).

type Chunk = string | Uint8Array;
/** Appends an indirect object and returns its number. */
type AddObject = (...body: Chunk[]) => number;

interface Page {
  size: [width: number, height: number];
  resources: string;
  content: string;
}

const LETTER: Page["size"] = [612, 792];
const SCAN_PX = 200; // the scan is drawn one point per pixel
const SQUARE_PX = 100;

/** One Letter page that shows `lines` in Helvetica 12 pt, each under the previous one. */
export function textPdf(lines: string[]): Uint8Array {
  return buildPdf([(add) => textPage(add, lines)]);
}

/** One page that is a 200×200 grayscale scan: white, with a black 100×100 square in the middle when `ink`. */
export function imagePdf({ ink }: { ink: boolean }): Uint8Array {
  return buildPdf([(add) => scanPage(add, ink)]);
}

/** One Letter page whose content stream is empty. */
export function blankPdf(): Uint8Array {
  return buildPdf([() => ({ size: LETTER, resources: "<< >>", content: "" })]);
}

/** One Letter page that strokes a thick black line and shows no text. */
export function pathPdf(): Uint8Array {
  return buildPdf([() => ({ size: LETTER, resources: "<< >>", content: "10 w 50 400 m 550 400 l S" })]);
}

/** A text page followed by an inked scan. */
export function twoPagePdf(): Uint8Array {
  return buildPdf([
    (add) => textPage(add, ["The first page of this bundle carries a text layer", "long enough to need no OCR."]),
    (add) => scanPage(add, true),
  ]);
}

function textPage(add: AddObject, lines: string[]): Page {
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const shown = lines.map((line) => `(${line.replace(/[\\()]/g, "\\$&")}) Tj T*`);
  return {
    size: LETTER,
    resources: `<< /Font << /F1 ${font} 0 R >> >>`,
    content: ["BT", "/F1 12 Tf", "14 TL", "72 720 Td", ...shown, "ET"].join("\n"),
  };
}

function scanPage(add: AddObject, ink: boolean): Page {
  const pixels = new Uint8Array(SCAN_PX * SCAN_PX).fill(0xff);
  if (ink) {
    const from = (SCAN_PX - SQUARE_PX) / 2;
    for (let row = from; row < from + SQUARE_PX; row++) {
      pixels.fill(0x00, row * SCAN_PX + from, row * SCAN_PX + from + SQUARE_PX);
    }
  }
  const image = add(
    ...stream(
      pixels,
      `/Type /XObject /Subtype /Image /Width ${SCAN_PX} /Height ${SCAN_PX} /ColorSpace /DeviceGray /BitsPerComponent 8`,
    ),
  );
  return {
    size: [SCAN_PX, SCAN_PX],
    resources: `<< /XObject << /Im1 ${image} 0 R >> >>`,
    content: `q ${SCAN_PX} 0 0 ${SCAN_PX} 0 0 cm /Im1 Do Q`,
  };
}

function buildPdf(pages: ((add: AddObject) => Page)[]): Uint8Array {
  // Object 1 is the catalog and object 2 the page tree, whose kids are known only at the end.
  const objects: Chunk[][] = [["<< /Type /Catalog /Pages 2 0 R >>"], []];
  const add: AddObject = (...body) => objects.push(body);
  const kids = pages.map((build) => {
    const { size, resources, content } = build(add);
    const contents = add(...stream(ascii(content)));
    return add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size.join(" ")}] /Resources ${resources} /Contents ${contents} 0 R >>`,
    );
  });
  objects[1] = [`<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${kids.length} >>`];
  return serialize(objects);
}

function stream(data: Uint8Array, dict = ""): Chunk[] {
  return [`<< /Length ${data.length}${dict && ` ${dict}`} >>\nstream\n`, data, "\nendstream"];
}

/** Header, objects, then the xref table (one 20-byte entry per object, offsets in bytes) and the trailer. */
function serialize(objects: Chunk[][]): Uint8Array {
  const parts: Uint8Array[] = [];
  let length = 0;
  const write = (chunk: Chunk): void => {
    const bytes = typeof chunk === "string" ? ascii(chunk) : chunk;
    parts.push(bytes);
    length += bytes.length;
  };
  write("%PDF-1.4\n");
  const offsets = objects.map((body, index) => {
    const offset = length;
    write(`${index + 1} 0 obj\n`);
    body.forEach(write);
    write("\nendobj\n");
    return offset;
  });
  const xref = length;
  write(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets) write(`${String(offset).padStart(10, "0")} 00000 n \n`);
  write(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const pdf = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    pdf.set(part, at);
    at += part.length;
  }
  return pdf;
}

/** The fixtures write printable ASCII only, so one character is one byte and the offsets hold. */
function ascii(text: string): Uint8Array {
  if (/[^\n\x20-\x7e]/.test(text)) throw new Error(`PDF fixture text must be ASCII: ${JSON.stringify(text)}`);
  return new TextEncoder().encode(text);
}
