import { expect, it } from "vitest";
import { decodeTextBytes, normalizeTextDocument, storableText } from "./text";

it("decodes UTF-8 and strips the BOM", () => {
  expect(decodeTextBytes(new TextEncoder().encode("\uFEFFΑγωγή αρ. 112/2025"))).toBe("Αγωγή αρ. 112/2025");
});
it("falls back to windows-1253 for a legacy Greek export", () => {
  const bytes = new Uint8Array([0xc1, 0xe3, 0xf9, 0xe3, 0xde]); // «Αγωγή» in windows-1253
  expect(decodeTextBytes(bytes)).toBe("Αγωγή");
});
it("returns null when neither decoding is clean", () => expect(decodeTextBytes(new Uint8Array([0xff, 0xfe, 0xfd]))).toBeNull());
it("normalizeTextDocument strips BOM, CRLF and trims; storableText replaces U+0000", () => {
  // A lone \r is a line break too; interior whitespace stays verbatim.
  expect(normalizeTextDocument("\uFEFF  Αγωγή\r\nαρ.  112\r2025\n\t")).toBe("Αγωγή\nαρ.  112\n2025");
  expect(storableText("Quali\u0000cations")).toBe("Quali\uFFFDcations");
  expect(normalizeTextDocument("a\u0000b")).toBe("a\uFFFDb");
});
