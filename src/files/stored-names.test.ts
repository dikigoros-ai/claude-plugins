import { expect, it } from "vitest";
import { assignStoredNames } from "./stored-names";

/** A selected file at `relativePath`, named by its last segment. */
function file(relativePath: string): { relativePath: string; name: string } {
  return { relativePath, name: relativePath.slice(relativePath.lastIndexOf("/") + 1) };
}

/** The stored names in selection order, as "relativePath → storedName". */
function assigned(paths: string[], taken: ReadonlyMap<string, string> = new Map()): string[] {
  const names = assignStoredNames(paths.map(file), taken);
  return paths.map((path) => `${path} → ${names.get(path)}`);
}

it("keeps the bare names when nothing clashes", () => {
  expect(assigned(["Pleadings/Αγωγή.pdf", "Old/Υπεράσπιση.docx", "notes.md"])).toEqual([
    "Pleadings/Αγωγή.pdf → Αγωγή.pdf",
    "Old/Υπεράσπιση.docx → Υπεράσπιση.docx",
    "notes.md → notes.md",
  ]);
});

it("returns one entry per selected file", () => {
  const names = assignStoredNames([file("a.pdf"), file("b/a.pdf")], new Map());
  expect(names.size).toBe(2);
});

it("numbers the second of two same-named files from different folders", () => {
  expect(assigned(["Pleadings/Αγωγή.pdf", "Old/Αγωγή.pdf"])).toEqual([
    "Pleadings/Αγωγή.pdf → Αγωγή.pdf",
    "Old/Αγωγή.pdf → Αγωγή (2).pdf",
  ]);
});

it("numbers the third (3)", () => {
  expect(assigned(["a/Αγωγή.pdf", "b/Αγωγή.pdf", "c/Αγωγή.pdf"])).toEqual([
    "a/Αγωγή.pdf → Αγωγή.pdf",
    "b/Αγωγή.pdf → Αγωγή (2).pdf",
    "c/Αγωγή.pdf → Αγωγή (3).pdf",
  ]);
});

it("puts the number at the end of a name without an extension", () => {
  expect(assigned(["a/Notes", "b/Notes"])).toEqual(["a/Notes → Notes", "b/Notes → Notes (2)"]);
});

it("puts the number before the last extension only", () => {
  expect(assigned(["a/report.final.pdf", "b/report.final.pdf"])).toEqual([
    "a/report.final.pdf → report.final.pdf",
    "b/report.final.pdf → report.final (2).pdf",
  ]);
});

it("keeps the name the link holds for the same relative path (a re-run)", () => {
  const taken = new Map([["Αγωγή.pdf", "Pleadings/Αγωγή.pdf"]]);
  expect(assigned(["Pleadings/Αγωγή.pdf"], taken)).toEqual(["Pleadings/Αγωγή.pdf → Αγωγή.pdf"]);
});

it("keeps a numbered name the link holds for the same relative path", () => {
  const taken = new Map([
    ["Αγωγή.pdf", "Pleadings/Αγωγή.pdf"],
    ["Αγωγή (2).pdf", "Old/Αγωγή.pdf"],
  ]);
  expect(assigned(["Old/Αγωγή.pdf"], taken)).toEqual(["Old/Αγωγή.pdf → Αγωγή (2).pdf"]);
});

it("counts a name the link holds for another relative path as taken", () => {
  const taken = new Map([["Αγωγή.pdf", "Pleadings/Αγωγή.pdf"]]);
  expect(assigned(["Old/Αγωγή.pdf"], taken)).toEqual(["Old/Αγωγή.pdf → Αγωγή (2).pdf"]);
});

it("moves on to (3) when the link holds the generated (2) for another path", () => {
  const taken = new Map([
    ["Αγωγή.pdf", "Pleadings/Αγωγή.pdf"],
    ["Αγωγή (2).pdf", "Archive/Αγωγή.pdf"],
  ]);
  expect(assigned(["Old/Αγωγή.pdf"], taken)).toEqual(["Old/Αγωγή.pdf → Αγωγή (3).pdf"]);
});

it("compares names case-insensitively", () => {
  expect(assigned(["a/Report.PDF", "b/report.pdf"])).toEqual([
    "a/Report.PDF → Report.PDF",
    "b/report.pdf → report (2).pdf",
  ]);
});

it("compares the link's names case-insensitively", () => {
  const taken = new Map([["REPORT.pdf", "a/REPORT.pdf"]]);
  expect(assigned(["b/report.pdf"], taken)).toEqual(["b/report.pdf → report (2).pdf"]);
});

it("treats the NFC and NFD forms of the same Greek name as one name", () => {
  const nfc = "Αγωγή.pdf".normalize("NFC");
  const nfd = "Αγωγή.pdf".normalize("NFD");
  expect(nfc).not.toBe(nfd);
  const names = assignStoredNames(
    [
      { relativePath: "a/x", name: nfc },
      { relativePath: "b/x", name: nfd },
    ],
    new Map(),
  );
  expect(names.get("a/x")).toBe(nfc);
  expect(names.get("b/x")?.normalize("NFC")).toBe("Αγωγή (2).pdf".normalize("NFC"));
});

it("treats an NFD name in the link as the same name as an NFC one selected", () => {
  const taken = new Map([["Αγωγή.pdf".normalize("NFD"), "Pleadings/Αγωγή.pdf"]]);
  expect(assigned(["Old/Αγωγή.pdf"], taken)).toEqual(["Old/Αγωγή.pdf → Αγωγή (2).pdf"]);
});

it("numbers a file whose bare name an earlier generated name holds", () => {
  expect(assigned(["a/x.pdf", "b/x.pdf", "c/x (2).pdf"])).toEqual([
    "a/x.pdf → x.pdf",
    "b/x.pdf → x (2).pdf",
    "c/x (2).pdf → x (2) (2).pdf",
  ]);
});
