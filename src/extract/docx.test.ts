// extractDocx on the real mammoth, with the minimal documents test/support/docx-fixture.ts builds.

import { describe, expect, it } from "vitest";
import { makeDocx } from "../../test/support/docx-fixture";
import { extractDocx } from "./docx";

const CLAIM = ["Αγωγή αρ. 112/2025", "Γεωργίου & Σία ΟΕ κατά Πέτρου, για την απόδοση του μισθίου."];
/** mammoth's raw text: each paragraph's text followed by a blank line. */
const CLAIM_TEXT = "Αγωγή αρ. 112/2025\n\nΓεωργίου & Σία ΟΕ κατά Πέτρου, για την απόδοση του μισθίου.\n\n";

describe("extractDocx", () => {
  it("returns the paragraphs joined by newlines, the Greek intact", async () => {
    expect(await extractDocx(await makeDocx(CLAIM))).toEqual({ fullText: CLAIM_TEXT });
  });

  it("reads only the bytes of the view it is given, not the rest of its buffer", async () => {
    // fs.readFile can hand back a small file as a view into a shared buffer; here the buffer holds
    // a second document after the first, and a zip is read from its end.
    const first = await makeDocx(CLAIM);
    const second = await makeDocx(["Ένα άλλο έγγραφο."]);
    const shared = new Uint8Array(first.length + second.length);
    shared.set(first, 0);
    shared.set(second, first.length);
    expect(await extractDocx(shared.subarray(0, first.length))).toEqual({ fullText: CLAIM_TEXT });
  });

  it("rejects bytes that are not a zip", async () => {
    await expect(extractDocx(new TextEncoder().encode("Αγωγή αρ. 112/2025, not a .docx"))).rejects.toThrow(/zip/);
  });
});
