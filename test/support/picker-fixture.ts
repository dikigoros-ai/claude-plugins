// A show_project_picker structuredContent for the picker's tests: a new matter with room 50 over a
// folder of 64 tickable files (twelve preselected, 34.2 MB together), one ineligible file of each
// kind the tests look at, and one already uploaded; and the same folder linked to matter #12.

import type { PickerFile, PickerInput } from "../../src/shared/picker-contract";

/** Each tickable PDF/DOCX: twelve of them make 34.2 MB (35,861,304 bytes / 1,048,576). */
export const FILE_BYTES = 2_988_442;

const pdf = (path: string): PickerFile => ({
  path,
  name: path.split("/").at(-1) ?? path,
  size_bytes: FILE_BYTES,
  type: "pdf",
  eligible: true,
});

export const EVIDENCE = Array.from({ length: 60 }, (_, i) => `Evidence/doc-${String(i + 1).padStart(2, "0")}.pdf`);

export const PRESELECT = ["Brief.pdf", "Pleadings/Αγωγή.pdf", "Pleadings/Ένσταση.docx", ...EVIDENCE.slice(0, 9)];

export function pickerInput(overrides: Partial<PickerInput> = {}): PickerInput {
  return {
    scan_id: "scan-1",
    mode: "new",
    root: "/Users/lawyer/Matters/Papadopoulos",
    room: 50,
    per_matter: 50,
    held: 0,
    matter: { title: "Παπαδόπουλος ν. Δημοκρατίας", type: "civil", case_reference: "Αγωγή 123/2026" },
    preselect: PRESELECT,
    folders: [
      { path: "", depth: 0 },
      { path: "Evidence", depth: 1 },
      { path: "Notes", depth: 1 },
      { path: "Old", depth: 1 },
      { path: "Pleadings", depth: 1 },
    ],
    files: [
      pdf("Brief.pdf"),
      ...EVIDENCE.map(pdf),
      { path: "Notes/memo.txt", name: "memo.txt", size_bytes: 1200, type: "text", eligible: true },
      { path: "Old/filed.pdf", name: "filed.pdf", size_bytes: 4000, type: "pdf", eligible: false, reason: "already_uploaded" },
      { path: "Old/huge.pdf", name: "huge.pdf", size_bytes: 60 * 1024 * 1024, type: "pdf", eligible: false, reason: "too_large" },
      { path: "Old/table.xlsx", name: "table.xlsx", size_bytes: 5000, type: null, eligible: false, reason: "unsupported_type" },
      pdf("Pleadings/Αγωγή.pdf"),
      { ...pdf("Pleadings/Ένσταση.docx"), type: "docx" },
    ],
    truncated: null,
    ...overrides,
  };
}

/** The same folder, linked to matter #12 that holds 30 of its 50 documents. */
export function linkedInput(overrides: Partial<PickerInput> = {}): PickerInput {
  const { matter: _matter, ...rest } = pickerInput();
  void _matter;
  return {
    ...rest,
    mode: "linked",
    linked_matter: { id: 12, title: "Παπαδόπουλος ν. Δημοκρατίας", url: "https://dikigoros.ai/matters/12" },
    room: 20,
    held: 30,
    preselect: PRESELECT.slice(0, 5),
    ...overrides,
  };
}
