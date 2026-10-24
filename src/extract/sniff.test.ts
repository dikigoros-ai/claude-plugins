import { expect, it } from "vitest";
import { headBytesBase64, sniffFileKind } from "./sniff";

it("recognises %PDF- and PK\\x03\\x04 and nothing else", () => {
  expect(sniffFileKind(new TextEncoder().encode("%PDF-1.7\n"))).toBe("pdf");
  expect(sniffFileKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe("docx");
  expect(sniffFileKind(new TextEncoder().encode("hello"))).toBeNull();
});
it("headBytesBase64 encodes exactly the first 8 bytes", () => {
  expect(headBytesBase64(new TextEncoder().encode("%PDF-1.7\nmore"))).toBe(Buffer.from("%PDF-1.7").toString("base64"));
});
