// The project picker's state, without any DOM: the tree built from show_project_picker's
// structuredContent, which files are ticked, the room they must fit in, the matter's fields and
// whether the selection may be submitted. The view (view.ts) renders it and calls into it; every
// rule the picker enforces lives here, so it is tested without a browser.

import type { PickerFile, PickerInput, PickerMatterFields, PickerMatterType } from "../shared/picker-contract";

/** A checkbox's state: "disabled" for a file that cannot be ticked or a folder holding none that can. */
export type CheckState = "checked" | "unchecked" | "mixed" | "disabled";

/** The longest title save_selection accepts, after trimming. */
export const TITLE_MAX = 300;

/** One folder of the tree, the root included (path ""). */
export interface TreeFolder {
  /** POSIX, from the root; "" for the root. */
  path: string;
  /** The last segment of `path`; "" for the root. */
  name: string;
  /** 0 for the root. */
  depth: number;
  /** Subfolders, by name (UTF-16 code unit, as the scan orders them). */
  folders: TreeFolder[];
  /** The files directly in this folder, by name. */
  files: PickerFile[];
}

export type ToggleFileResult = { ok: true } | { refused: "over_room" | "ineligible" | "already_uploaded" };
export type ToggleFolderResult = { ok: true; added: number; removed: number; leftOut: number };
export type SubmitGate =
  | { ok: true }
  | { ok: false; why: "title_required" | "title_too_long" | "nothing_selected" | "over_room" };

/** The matter fields as the form edits them: every field a string, "" for none. */
interface MatterDraft {
  title: string;
  type: PickerMatterType | "";
  case_reference: string;
  description: string;
}

export class PickerModel {
  readonly input: PickerInput;
  readonly room: number;
  readonly root: TreeFolder;
  /** Every file, in tree order: a folder's own files, then each subfolder's, depth first. */
  readonly #order: PickerFile[];
  readonly #byPath = new Map<string, PickerFile>();
  readonly #folders = new Map<string, TreeFolder>();
  /** Per folder path: the tickable files of its whole subtree, in tree order. */
  readonly #subtreeTickable = new Map<string, string[]>();
  /** Claude's preselection, reduced to tickable paths, without duplicates, in tree order. */
  readonly #suggested: string[];
  readonly #selected = new Set<string>();
  #matter: MatterDraft;

  constructor(input: PickerInput) {
    this.input = input;
    this.room = Math.max(0, Math.floor(input.room));
    this.root = { path: "", name: "", depth: 0, folders: [], files: [] };
    this.#folders.set("", this.root);
    for (const folder of input.folders) this.#folder(folder.path);
    for (const file of input.files) {
      if (this.#byPath.has(file.path)) continue;
      this.#byPath.set(file.path, file);
      this.#folder(parentOf(file.path)).files.push(file);
    }
    sortTree(this.root);
    this.#order = [];
    this.#collect(this.root);
    const wanted = new Set(input.preselect);
    this.#suggested = this.#order.filter((file) => wanted.has(file.path) && isTickable(file)).map((file) => file.path);
    for (const path of this.#suggested) this.#selected.add(path);
    const proposal = input.matter;
    this.#matter = {
      title: proposal?.title ?? "",
      type: proposal?.type ?? "",
      case_reference: proposal?.case_reference ?? "",
      description: proposal?.description ?? "",
    };
  }

  get mode(): "new" | "linked" {
    return this.input.mode;
  }

  /** The files in tree order. */
  files(): readonly PickerFile[] {
    return this.#order;
  }

  file(path: string): PickerFile | undefined {
    return this.#byPath.get(path);
  }

  folder(path: string): TreeFolder | undefined {
    return this.#folders.get(path);
  }

  /** Whether a file can ever be ticked: eligible (an already-uploaded file is not). */
  tickable(path: string): boolean {
    const file = this.#byPath.get(path);
    return file !== undefined && isTickable(file);
  }

  /** The tickable files of a folder's whole subtree, in tree order. */
  tickableIn(folderPath: string): readonly string[] {
    return this.#subtreeTickable.get(folderPath) ?? [];
  }

  selectedCount(): number {
    return this.#selected.size;
  }

  selectedBytes(): number {
    let total = 0;
    for (const path of this.#selected) total += this.#byPath.get(path)?.size_bytes ?? 0;
    return total;
  }

  isSelected(path: string): boolean {
    return this.#selected.has(path);
  }

  fileState(path: string): CheckState {
    if (!this.tickable(path)) return "disabled";
    return this.#selected.has(path) ? "checked" : "unchecked";
  }

  folderState(path: string): CheckState {
    const tickable = this.tickableIn(path);
    if (tickable.length === 0) return "disabled";
    const ticked = tickable.filter((p) => this.#selected.has(p)).length;
    if (ticked === 0) return "unchecked";
    return ticked === tickable.length ? "checked" : "mixed";
  }

  /** Ticks or clears one file. Refused when it cannot be ticked, or when ticking it would pass the room. */
  toggleFile(path: string): ToggleFileResult {
    const file = this.#byPath.get(path);
    if (file === undefined) return { refused: "ineligible" };
    if (file.reason === "already_uploaded") return { refused: "already_uploaded" };
    if (!isTickable(file)) return { refused: "ineligible" };
    if (this.#selected.delete(path)) return { ok: true };
    if (this.#selected.size >= this.room) return { refused: "over_room" };
    this.#selected.add(path);
    return { ok: true };
  }

  /**
   * A folder's checkbox: when every tickable file of its subtree is ticked, clears them all; otherwise
   * ticks the unticked ones in tree order until the room is full. `leftOut` counts those the room had
   * no place for.
   */
  toggleFolder(path: string): ToggleFolderResult {
    const tickable = this.tickableIn(path);
    const unticked = tickable.filter((p) => !this.#selected.has(p));
    if (unticked.length === 0) {
      for (const p of tickable) this.#selected.delete(p);
      return { ok: true, added: 0, removed: tickable.length, leftOut: 0 };
    }
    const free = Math.max(0, this.room - this.#selected.size);
    const added = unticked.slice(0, free);
    for (const p of added) this.#selected.add(p);
    return { ok: true, added: added.length, removed: 0, leftOut: unticked.length - added.length };
  }

  /** Back to Claude's preselection. */
  resetToSuggested(): void {
    this.#selected.clear();
    for (const path of this.#suggested) this.#selected.add(path);
  }

  clear(): void {
    this.#selected.clear();
  }

  /** The matter fields as the form holds them, untrimmed. */
  matter(): Readonly<MatterDraft> {
    return this.#matter;
  }

  /** Changes some of the matter fields; an empty `type` means none. */
  setMatter(fields: Partial<MatterDraft>): void {
    this.#matter = { ...this.#matter, ...fields };
  }

  canSubmit(): SubmitGate {
    if (this.mode === "new") {
      const title = this.#matter.title.trim();
      if (title === "") return { ok: false, why: "title_required" };
      if (title.length > TITLE_MAX) return { ok: false, why: "title_too_long" };
    }
    if (this.#selected.size === 0) return { ok: false, why: "nothing_selected" };
    if (this.#selected.size > this.room) return { ok: false, why: "over_room" };
    return { ok: true };
  }

  /** What save_selection gets: the ticked paths in tree order and, for a new matter, the trimmed fields. */
  selection(): { relative_paths: string[]; matter: PickerMatterFields | null } {
    const relative_paths = this.#order.filter((file) => this.#selected.has(file.path)).map((file) => file.path);
    if (this.mode === "linked") return { relative_paths, matter: null };
    const draft = this.#matter;
    const matter: PickerMatterFields = { title: draft.title.trim() };
    if (draft.type !== "") matter.type = draft.type;
    const caseReference = draft.case_reference.trim();
    if (caseReference !== "") matter.case_reference = caseReference;
    const description = draft.description.trim();
    if (description !== "") matter.description = description;
    return { relative_paths, matter };
  }

  /** The folder at `path`, made with its missing ancestors when the input did not list it. */
  #folder(path: string): TreeFolder {
    const found = this.#folders.get(path);
    if (found !== undefined) return found;
    const parent = this.#folder(parentOf(path));
    const folder: TreeFolder = { path, name: path.split("/").at(-1) ?? path, depth: parent.depth + 1, folders: [], files: [] };
    parent.folders.push(folder);
    this.#folders.set(path, folder);
    return folder;
  }

  /** Fills #order and #subtreeTickable depth first; returns the folder's tickable paths. */
  #collect(folder: TreeFolder): string[] {
    const tickable: string[] = [];
    for (const file of folder.files) {
      this.#order.push(file);
      if (isTickable(file)) tickable.push(file.path);
    }
    for (const sub of folder.folders) tickable.push(...this.#collect(sub));
    this.#subtreeTickable.set(folder.path, tickable);
    return tickable;
  }
}

function isTickable(file: PickerFile): boolean {
  return file.eligible && file.reason === undefined;
}

/** "Pleadings/2024/a.pdf" → "Pleadings/2024"; "a.pdf" → "". */
function parentOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortTree(folder: TreeFolder): void {
  folder.files.sort((a, b) => byCodeUnit(a.name, b.name));
  folder.folders.sort((a, b) => byCodeUnit(a.name, b.name));
  for (const sub of folder.folders) sortTree(sub);
}
