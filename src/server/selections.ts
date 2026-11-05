// The scans `scan_project` made and the selections `save_selection` confirmed, kept in the helper's
// memory only: the newest few scans, each with the selections made from it. A selection is checked
// against its scan (every path in it, eligible, once each, within the room, a title for a new matter)
// before it is kept, and `init_matter` uploads only a selection this store issued. Nothing here is
// written to disk; a restart of the helper forgets it all.

import { randomBytes } from "node:crypto";
import { type PlanEntry, planDigest } from "../files/resolve";
import type { ProjectScan, ScannedFile, ScanReason } from "../files/scan";
import type { MatterLink } from "../link/link-file";
import type { Room } from "./room";
import type { MATTER_TYPES } from "./tools";

/** How many scans the store keeps unless told otherwise. */
export const DEFAULT_SCAN_CAPACITY = 8;
/** The longest title a new matter may have, once trimmed. */
export const MAX_TITLE_CHARS = 300;

/** One of the matter types create_matter takes. */
export type MatterType = (typeof MATTER_TYPES)[number];

/** A scan as the store keeps it, with the room and the link file it was made with. */
export interface StoredScan {
  scanId: string;
  scan: ProjectScan;
  room: Room;
  /** The folder's link file; null when the folder is not linked, and a new matter is to be made. */
  linked: MatterLink | null;
  /** From the store's clock, when the scan was put. */
  createdAt: number;
}

/** The fields of the matter a selection in an unlinked folder opens. */
export interface MatterFields {
  title: string;
  type?: MatterType;
  case_reference?: string;
  description?: string;
}

/** A selection the store checked and kept. */
export interface StoredSelection {
  selectionId: string;
  scanId: string;
  /** planDigest over the selected files' real paths and sizes, as the scan saw them. */
  digest: string;
  /** The scan's own entries, in the order they were selected. */
  files: ScannedFile[];
  /** The trimmed matter fields; null in a linked folder, where no matter is made. */
  matter: MatterFields | null;
}

/** Why a selection was not kept. */
export type SelectionRefusal =
  | { code: "unknown_scan" }
  | { code: "not_in_scan"; path: string }
  | { code: "ineligible"; path: string; reason: ScanReason }
  | { code: "duplicate_path"; path: string }
  | { code: "over_room"; count: number; room: number }
  | { code: "empty_selection" }
  | { code: "title_required" };

/** 16 random bytes as base64url: 22 characters. */
function defaultRandomId(): string {
  return randomBytes(16).toString("base64url");
}

/** Scans and confirmed selections in memory, the newest `capacity` scans and the selections made from them. */
export class SelectionStore {
  readonly #capacity: number;
  readonly #now: () => number;
  readonly #randomId: () => string;
  /** By scan id, oldest first (a Map keeps the order of insertion). */
  readonly #scans = new Map<string, StoredScan>();
  readonly #selections = new Map<string, StoredSelection>();

  /** `capacity` scans are kept (DEFAULT_SCAN_CAPACITY unless given); `randomId` makes every id. */
  constructor(opts: { capacity?: number; now: () => number; randomId?: () => string }) {
    this.#capacity = opts.capacity ?? DEFAULT_SCAN_CAPACITY;
    this.#now = opts.now;
    this.#randomId = opts.randomId ?? defaultRandomId;
  }

  /** Keeps `scan` under a new id; past the capacity, the oldest scan goes, with every selection made from it. */
  putScan(scan: ProjectScan, room: Room, linked: MatterLink | null): StoredScan {
    const stored: StoredScan = { scanId: this.#randomId(), scan, room, linked, createdAt: this.#now() };
    this.#scans.set(stored.scanId, stored);
    while (this.#scans.size > this.#capacity) {
      const oldest = this.#scans.keys().next().value;
      if (oldest === undefined) break;
      this.#scans.delete(oldest);
      for (const [selectionId, selection] of this.#selections) {
        if (selection.scanId === oldest) this.#selections.delete(selectionId);
      }
    }
    return stored;
  }

  /** The scan kept under `scanId`, unless it was never put or has been dropped. */
  getScan(scanId: string): StoredScan | undefined {
    return this.#scans.get(scanId);
  }

  /**
   * Checks `relativePaths` against the scan and keeps them as a selection, or says why not. The
   * checks, in order: the scan is held; the list is not empty; each path, in turn, is in the scan,
   * not given before, and eligible; there are no more of them than the room; and, in a folder that is
   * not linked, the matter has a title of 1 to MAX_TITLE_CHARS characters once trimmed. In a linked
   * folder `matter` is ignored.
   */
  select(scanId: string, relativePaths: string[], matter: MatterFields | null): StoredSelection | SelectionRefusal {
    const stored = this.#scans.get(scanId);
    if (stored === undefined) return { code: "unknown_scan" };
    if (relativePaths.length === 0) return { code: "empty_selection" };
    const byPath = new Map(stored.scan.files.map((file) => [file.relativePath, file]));
    const files: ScannedFile[] = [];
    const seen = new Set<string>();
    for (const path of relativePaths) {
      const file = byPath.get(path);
      if (file === undefined) return { code: "not_in_scan", path };
      if (seen.has(path)) return { code: "duplicate_path", path };
      if (!file.eligible) return { code: "ineligible", path, reason: file.reason ?? "unsupported_type" };
      seen.add(path);
      files.push(file);
    }
    if (files.length > stored.room.room) return { code: "over_room", count: files.length, room: stored.room.room };
    let fields: MatterFields | null = null;
    if (stored.linked === null) {
      fields = matter === null ? null : trimmed(matter);
      if (fields === null) return { code: "title_required" };
    }
    const selection: StoredSelection = {
      selectionId: this.#randomId(),
      scanId,
      digest: planDigest(files.map(asUpload)),
      files,
      matter: fields,
    };
    this.#selections.set(selection.selectionId, selection);
    return selection;
  }

  /** The selection kept under `selectionId`, unless it was never made or its scan has been dropped. */
  getSelection(selectionId: string): StoredSelection | undefined {
    return this.#selections.get(selectionId);
  }
}

/** The fields trimmed, an optional one left out when it trims to nothing; null when the title is
 *  empty or longer than MAX_TITLE_CHARS once trimmed. */
function trimmed(matter: MatterFields): MatterFields | null {
  const title = matter.title.trim();
  if (title.length === 0 || title.length > MAX_TITLE_CHARS) return null;
  const fields: MatterFields = { title };
  if (matter.type !== undefined) fields.type = matter.type;
  const caseReference = matter.case_reference?.trim();
  if (caseReference) fields.case_reference = caseReference;
  const description = matter.description?.trim();
  if (description) fields.description = description;
  return fields;
}

/** A selected file as the upload entry planDigest reads. */
function asUpload(file: ScannedFile): PlanEntry {
  return {
    path: file.path,
    realPath: file.realPath,
    name: file.name,
    sizeBytes: file.sizeBytes,
    kind: file.kind,
    decision: "upload",
  };
}
