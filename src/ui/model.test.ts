import { describe, expect, it } from "vitest";
import { EVIDENCE, FILE_BYTES, linkedInput, pickerInput, PRESELECT } from "../../test/support/picker-fixture";
import { PickerModel } from "./model";

describe("PickerModel", () => {
  it("ticks the preselection at start, counts it and its bytes", () => {
    const model = new PickerModel(pickerInput());
    expect(model.room).toBe(50);
    expect(model.selectedCount()).toBe(12);
    expect(model.selectedBytes()).toBe(12 * FILE_BYTES);
    for (const path of PRESELECT) expect(model.fileState(path)).toBe("checked");
    expect(model.fileState("Notes/memo.txt")).toBe("unchecked");
  });

  it("ignores preselected paths that are not in the scan, ineligible, already uploaded or repeated", () => {
    const model = new PickerModel(
      pickerInput({ preselect: ["Brief.pdf", "Brief.pdf", "Old/huge.pdf", "Old/filed.pdf", "Missing.pdf"] }),
    );
    expect(model.selection().relative_paths).toEqual(["Brief.pdf"]);
  });

  it("orders the tree as the scan does: a folder's own files, then its subfolders by name", () => {
    const model = new PickerModel(pickerInput());
    expect(model.root.folders.map((f) => f.path)).toEqual(["Evidence", "Notes", "Old", "Pleadings"]);
    expect(model.files()[0].path).toBe("Brief.pdf");
    expect(model.files()[1].path).toBe("Evidence/doc-01.pdf");
    expect(model.tickableIn("Old")).toEqual([]);
  });

  it("makes the folders a file path names when the input did not list them", () => {
    const input = pickerInput({ folders: [] });
    const model = new PickerModel(input);
    expect(model.folder("Pleadings")?.files.map((f) => f.name)).toEqual(["Ένσταση.docx", "Αγωγή.pdf"]);
  });

  it("refuses the 51st tick at room 50 and lets a ticked file be cleared", () => {
    const model = new PickerModel(pickerInput({ preselect: EVIDENCE.slice(0, 50) }));
    expect(model.selectedCount()).toBe(50);
    expect(model.toggleFile("Brief.pdf")).toEqual({ refused: "over_room" });
    expect(model.selectedCount()).toBe(50);
    expect(model.toggleFile(EVIDENCE[0])).toEqual({ ok: true });
    expect(model.toggleFile("Brief.pdf")).toEqual({ ok: true });
    expect(model.fileState("Brief.pdf")).toBe("checked");
  });

  it("never ticks an ineligible or an already-uploaded file", () => {
    const model = new PickerModel(pickerInput());
    expect(model.toggleFile("Old/huge.pdf")).toEqual({ refused: "ineligible" });
    expect(model.toggleFile("Old/table.xlsx")).toEqual({ refused: "ineligible" });
    expect(model.toggleFile("Old/filed.pdf")).toEqual({ refused: "already_uploaded" });
    expect(model.toggleFile("Nowhere.pdf")).toEqual({ refused: "ineligible" });
    expect(model.fileState("Old/filed.pdf")).toBe("disabled");
    expect(model.folderState("Old")).toBe("disabled");
    expect(model.toggleFolder("Old")).toEqual({ ok: true, added: 0, removed: 0, leftOut: 0 });
  });

  it("shows a folder as mixed, checked or unchecked over its whole subtree", () => {
    const model = new PickerModel(pickerInput());
    expect(model.folderState("Pleadings")).toBe("checked");
    expect(model.folderState("Evidence")).toBe("mixed");
    expect(model.folderState("Notes")).toBe("unchecked");
    expect(model.folderState("")).toBe("mixed");
    model.toggleFile("Pleadings/Αγωγή.pdf");
    expect(model.folderState("Pleadings")).toBe("mixed");
  });

  it("a folder tick stops at the room, in tree order, and reports what it left out", () => {
    const model = new PickerModel(pickerInput());
    expect(model.toggleFolder("Evidence")).toEqual({ ok: true, added: 38, removed: 0, leftOut: 13 });
    expect(model.selectedCount()).toBe(50);
    expect(model.fileState(EVIDENCE[46])).toBe("checked");
    expect(model.fileState(EVIDENCE[47])).toBe("unchecked");
    expect(model.folderState("Evidence")).toBe("mixed");
    // Full: a further folder tick adds nothing.
    expect(model.toggleFolder("Notes")).toEqual({ ok: true, added: 0, removed: 0, leftOut: 1 });
  });

  it("a folder tick clears the subtree when all of it is ticked", () => {
    const model = new PickerModel(pickerInput());
    expect(model.toggleFolder("Pleadings")).toEqual({ ok: true, added: 0, removed: 2, leftOut: 0 });
    expect(model.folderState("Pleadings")).toBe("unchecked");
    expect(model.selectedCount()).toBe(10);
  });

  it("the root folder ticks files in tree order up to the room", () => {
    const model = new PickerModel(pickerInput({ preselect: [] }));
    expect(model.toggleFolder("")).toEqual({ ok: true, added: 50, removed: 0, leftOut: 14 });
    const paths = model.selection().relative_paths;
    expect(paths[0]).toBe("Brief.pdf");
    expect(paths.at(-1)).toBe(EVIDENCE[48]);
  });

  it("Suggested goes back to the preselection; Clear empties it", () => {
    const model = new PickerModel(pickerInput());
    model.toggleFolder("Notes");
    model.toggleFile("Brief.pdf");
    model.resetToSuggested();
    expect(model.selection().relative_paths).toEqual(new PickerModel(pickerInput()).selection().relative_paths);
    model.clear();
    expect(model.selectedCount()).toBe(0);
  });

  it("canSubmit: title required, title too long, nothing selected, over the room", () => {
    const model = new PickerModel(pickerInput());
    expect(model.canSubmit()).toEqual({ ok: true });
    model.setMatter({ title: "   " });
    expect(model.canSubmit()).toEqual({ ok: false, why: "title_required" });
    model.setMatter({ title: "x".repeat(301) });
    expect(model.canSubmit()).toEqual({ ok: false, why: "title_too_long" });
    model.setMatter({ title: `  ${"x".repeat(300)}  ` });
    expect(model.canSubmit()).toEqual({ ok: true });
    model.clear();
    expect(model.canSubmit()).toEqual({ ok: false, why: "nothing_selected" });
    const over = new PickerModel(pickerInput({ room: 5 }));
    expect(over.selectedCount()).toBe(12);
    expect(over.canSubmit()).toEqual({ ok: false, why: "over_room" });
  });

  it("selection() trims the fields and leaves out the empty ones", () => {
    const model = new PickerModel(pickerInput());
    model.setMatter({ title: "  Αγωγή Παπαδόπουλου  ", type: "", case_reference: "  ", description: " Σημειώσεις " });
    expect(model.selection().matter).toEqual({ title: "Αγωγή Παπαδόπουλου", description: "Σημειώσεις" });
    model.setMatter({ type: "appeal" });
    expect(model.selection().matter?.type).toBe("appeal");
  });

  it("linked mode: room from the input, no title needed, matter null", () => {
    const model = new PickerModel(linkedInput());
    expect(model.room).toBe(20);
    expect(model.canSubmit()).toEqual({ ok: true });
    expect(model.selection()).toEqual({ relative_paths: PRESELECT.slice(0, 5).sort(treeOrder), matter: null });
  });
});

/** The fixture's five first preselected paths sort as the tree does: Brief, Evidence/*, Pleadings/*. */
function treeOrder(a: string, b: string): number {
  const rank = (p: string) => (p.includes("/") ? 1 : 0);
  return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
}
