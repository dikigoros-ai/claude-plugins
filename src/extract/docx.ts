// DOCX text extraction in Node, ported from extractDocx in dikigoros-ai/dikigoros-ai
// lib/matter-extract.ts @ 37f39ac5 (2026-10-19): mammoth's raw text of the document, verbatim, the
// `fullText` of the ingest manifest. The browser hands mammoth an ArrayBuffer; in Node it takes a
// Buffer.

import mammoth from "mammoth";

/**
 * The document's raw text as mammoth reads it: each paragraph's text followed by a blank line,
 * tabs as "\t", no formatting. Rejects when the bytes are not a .docx: not a zip, or a zip without
 * a main document part.
 */
export async function extractDocx(bytes: Uint8Array): Promise<{ fullText: string }> {
  // A copy of the view's bytes only: the view may sit inside a larger buffer.
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return { fullText: result.value };
}
