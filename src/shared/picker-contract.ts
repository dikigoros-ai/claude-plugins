// What passes between the helper and the project picker widget: show_project_picker's
// structuredContent (PickerInput), which the widget renders, and save_selection's arguments and
// answer, which the widget sends and reads. Types and constants only, importing nothing, because the
// widget bundle (src/ui) imports this file and must not pull in any server code.

/** The matter types a lawyer may pick; the same list as MATTER_TYPES in src/server/tools.ts (tested). */
export const PICKER_MATTER_TYPES = ["civil", "criminal", "interim_application", "appeal", "other"] as const;
export type PickerMatterType = (typeof PICKER_MATTER_TYPES)[number];

/** Why a file cannot be ticked: the scan's reasons (src/files/scan.ts ScanReason) the picker shows. */
export type PickerReason =
  | "unsupported_type"
  | "too_large"
  | "empty"
  | "unreadable"
  | "outside_directory"
  | "not_found"
  | "already_uploaded"
  | "other";

/** The matter's fields as the picker edits them; a new matter only. */
export interface PickerMatterFields {
  title: string;
  type?: PickerMatterType;
  case_reference?: string;
  description?: string;
}

/** One file of the tree. */
export interface PickerFile {
  /** POSIX, from the root: "Pleadings/Αγωγή.pdf". The key every other field refers to a file by. */
  path: string;
  /** The basename, verbatim. */
  name: string;
  size_bytes: number;
  /** null for a file whose type the scan could not tell. */
  type: "pdf" | "docx" | "text" | null;
  eligible: boolean;
  /** Present exactly when `eligible` is false. */
  reason?: PickerReason;
}

/** One folder of the tree, the root included (path ""). */
export interface PickerFolder {
  path: string;
  depth: number;
}

/** show_project_picker's structuredContent: everything the widget renders. */
export interface PickerInput {
  scan_id: string;
  /** "new": a matter will be created; "linked": the folder is already this matter. */
  mode: "new" | "linked";
  /** The folder's absolute path, for display only. */
  root: string;
  /** The linked matter, in linked mode. */
  linked_matter?: { id: number; title: string; url: string };
  /** How many files this selection may hold (the room of src/server/room.ts). */
  room: number;
  /** The plan's documents per matter (null: unlimited) and those the linked matter holds already. */
  per_matter: number | null;
  held: number;
  /** Claude's proposal, new mode only. */
  matter?: PickerMatterFields;
  /** Paths Claude preselected: in the scan, eligible, at most `room`. */
  preselect: string[];
  folders: PickerFolder[];
  files: PickerFile[];
  truncated: null | "depth" | "entries";
}

/** save_selection's arguments, as the widget sends them. */
export interface SaveSelectionArgs {
  scan_id: string;
  relative_paths: string[];
  /** New mode only; omitted in linked mode. */
  matter?: PickerMatterFields;
}

/** save_selection's structuredContent on success. */
export interface SaveSelectionResult {
  selection_id: string;
  digest: string;
  count: number;
  total_bytes: number;
}

/** save_selection's structuredContent on a refusal (the result also has isError: true). */
export interface SaveSelectionRefusal {
  refused:
    | "unknown_scan"
    | "not_in_scan"
    | "ineligible"
    | "duplicate_path"
    | "over_room"
    | "empty_selection"
    | "title_required";
  /** The path the refusal is about, when it is about one. */
  path?: string;
}
