// Ported verbatim from dikigoros-ai/dikigoros-ai lib/matter-blob.ts @ 37f39ac5 (2026-10-19). Environment-neutral; sharing it as a package is a follow-up.

/** Magic-bytes check — extension and claimed MIME are never trusted (spec §7). */
export function sniffFileKind(bytes: Uint8Array): "pdf" | "docx" | null {
  if (bytes.length >= 5) {
    const head = String.fromCharCode(...Array.from(bytes.slice(0, 5)));
    if (head === "%PDF-") return "pdf";
  }
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return "docx";
  }
  return null;
}

/** Not ported: the helper's own. Base64 of the first 8 bytes, the
 *  `headBytesBase64` the documents route decodes and runs sniffFileKind on
 *  (the browser builds the same string with `btoa` in use-document-upload.ts). */
export function headBytesBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.subarray(0, 8)).toString("base64");
}
