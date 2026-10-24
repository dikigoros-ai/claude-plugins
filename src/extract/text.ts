// Ported verbatim from dikigoros-ai/dikigoros-ai lib/text-file-decode.ts and lib/matters.ts @ 37f39ac5 (2026-10-19). Environment-neutral; sharing it as a package is a follow-up.

// Chat uploads (spec §4.4): a `.txt`/`.md` dropped on the chat is UTF-8 unless
// it is a legacy Windows Greek export. Pure and browser-safe (TextDecoder).
// The one change from the source: `bytes` is a Uint8Array only (no ArrayBuffer).
export function decodeTextBytes(bytes: Uint8Array): string | null {
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  if (!utf8.includes("\uFFFD")) return utf8.replace(/^\uFEFF/, "");
  try {
    const greek = new TextDecoder("windows-1253").decode(bytes);
    if (!greek.includes("\uFFFD")) return greek;
  } catch {
    // An engine without the legacy Greek table — none we ship to; fall through.
  }
  return null;
}

/** Chat uploads (spec §4.3/§4.4): the text-document path's cap. */
export const MAX_TEXT_DOCUMENT_CHARS = 200_000;

const NUL_CHARS = new RegExp(String.fromCharCode(0), "g");
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

/**
 * Text Postgres can store. U+0000 is refused in `text` and `jsonb` alike
 * (SQLSTATE 22P05), and a PDF can carry it: for a glyph whose font has no
 * Unicode mapping — typically the "fi" ligature of a web page printed to PDF
 * — pdfjs emits U+0000 in the text layer («Quali?cations»). One such page
 * made the ingest manifest's UPDATE throw, and the document stayed "pending"
 * for good (staging document 94, 2026-09-30). The character becomes U+FFFD,
 * the replacement character: the gap stays visible to the reader and to the
 * model instead of two halves of a word silently closing up.
 */
export function storableText(text: string): string {
  return text.replace(NUL_CHARS, REPLACEMENT_CHAR);
}

/** BOM off, `\r\n`/`\r` → `\n`, ends trimmed, interior whitespace verbatim.
 *  Applied by the server before hashing AND by the composer before matching a
 *  paste against the textarea (which stores `\n`), so the two agree. */
export function normalizeTextDocument(raw: string): string {
  return storableText(raw).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
}
