// SelectionStore against hand-built scans: a clock the test moves and, unless a test needs the real
// ones, ids counted up from "id-1". The scan holds three eligible files, one too large and one the
// link file records as uploaded.

import { describe, expect, it } from "vitest";
import { planDigest } from "../files/resolve";
import type { ProjectScan, ScannedFile } from "../files/scan";
import type { MatterLink } from "../link/link-file";
import { computeRoom, type Room } from "./room";
import { type MatterFields, SelectionStore, type StoredSelection } from "./selections";

const ROOT = "/Users/eleni/Matters/Georgiou";

function file(relativePath: string, over: Partial<ScannedFile> = {}): ScannedFile {
  return {
    relativePath,
    path: `${ROOT}/${relativePath}`,
    realPath: `${ROOT}/${relativePath}`,
    name: relativePath.split("/").at(-1) ?? relativePath,
    sizeBytes: 48_213,
    mtimeMs: 1_762_300_000_000,
    kind: "pdf",
    eligible: true,
    ...over,
  };
}

const SCAN: ProjectScan = {
  root: ROOT,
  realRoot: ROOT,
  files: [
    file("Σημειώσεις.pdf", { sizeBytes: 1_000 }),
    file("Pleadings/Αγωγή.pdf", { sizeBytes: 2_000 }),
    file("Pleadings/Υπεράσπιση.docx", { kind: "docx", sizeBytes: 3_000 }),
    file("Pleadings/Bundle.pdf", { eligible: false, reason: "too_large", sizeBytes: 60_000_000 }),
    file("Old/Αγωγή.pdf", { eligible: false, reason: "already_uploaded" }),
  ],
  folders: [
    { relativePath: "", depth: 0, files: 1, eligible: 1 },
    { relativePath: "Old", depth: 1, files: 1, eligible: 0 },
    { relativePath: "Pleadings", depth: 1, files: 3, eligible: 2 },
  ],
  truncated: null,
};

const ROOM: Room = computeRoom({ entitlements: { docsPerMatter: 50, activeMatters: 10 }, openMatters: 3, linkedHeld: null });

const LINK: MatterLink = {
  version: 1,
  baseUrl: "https://dikigoros.ai",
  matterId: 7,
  title: "Γεωργίου κατά Πέτρου",
  url: "https://dikigoros.ai/matters/7",
  createdAt: "2026-11-05T10:00:00.000Z",
  files: [],
};

const MATTER: MatterFields = { title: "Γεωργίου κατά Πέτρου" };

/** A store with a clock at 1000 that `tick` moves, and counted ids unless `real` is set. */
function store(opts: { capacity?: number; real?: boolean } = {}) {
  let clock = 1000;
  let counter = 0;
  const randomId = opts.real ? undefined : () => `id-${++counter}`;
  const selections = new SelectionStore({ capacity: opts.capacity, now: () => clock, randomId });
  return {
    selections,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

const pathsOf = ({ path, realPath, name }: ScannedFile) => ({ path, realPath, name });

const isSelection = (result: unknown): result is StoredSelection =>
  typeof result === "object" && result !== null && "selectionId" in result;

describe("SelectionStore: scans", () => {
  it("keeps a scan with its room, its link and the time it was put", () => {
    const { selections } = store();
    const stored = selections.putScan(SCAN, ROOM, LINK);
    expect(stored).toStrictEqual({ scanId: "id-1", scan: SCAN, room: ROOM, linked: LINK, createdAt: 1000 });
    expect(selections.getScan("id-1")).toBe(stored);
    expect(selections.getScan("id-2")).toBeUndefined();
  });

  it("gives ids of 22 base64url characters, each different, by default", () => {
    const { selections } = store({ real: true });
    const scanIds = Array.from({ length: 8 }, () => selections.putScan(SCAN, ROOM, null).scanId);
    const picked = selections.select(scanIds[0], ["Σημειώσεις.pdf"], MATTER);
    expect(isSelection(picked)).toBe(true);
    const ids = [...scanIds, isSelection(picked) ? picked.selectionId : ""];
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("drops the oldest scan, and every selection made from it, when a 9th is put", () => {
    const { selections, tick } = store();
    const scans = Array.from({ length: 8 }, () => {
      tick(1);
      return selections.putScan(SCAN, ROOM, null);
    });
    const fromOldest = selections.select(scans[0].scanId, ["Σημειώσεις.pdf"], MATTER);
    const fromSecond = selections.select(scans[1].scanId, ["Σημειώσεις.pdf"], MATTER);
    if (!isSelection(fromOldest) || !isSelection(fromSecond)) throw new Error("expected two selections");

    const ninth = selections.putScan(SCAN, ROOM, null);

    expect(selections.getScan(scans[0].scanId)).toBeUndefined();
    expect(selections.getSelection(fromOldest.selectionId)).toBeUndefined();
    expect(selections.select(scans[0].scanId, ["Σημειώσεις.pdf"], MATTER)).toStrictEqual({ code: "unknown_scan" });
    for (const kept of [...scans.slice(1), ninth]) expect(selections.getScan(kept.scanId)).toBe(kept);
    expect(selections.getSelection(fromSecond.selectionId)).toBe(fromSecond);
  });

  it("keeps a proposal on a scan it holds, the newest replacing the one before", () => {
    const { selections } = store();
    const stored = selections.putScan(SCAN, ROOM, null);
    expect(stored.proposal).toBeUndefined();
    expect(selections.propose(stored.scanId, { matter: MATTER, preselect: ["Σημειώσεις.pdf"] })).toBe(stored);
    selections.propose(stored.scanId, { matter: null, preselect: [] });
    expect(selections.getScan(stored.scanId)?.proposal).toStrictEqual({ matter: null, preselect: [] });
  });

  it("keeps no proposal for a scan it does not hold", () => {
    const { selections } = store();
    expect(selections.propose("id-9", { matter: MATTER, preselect: [] })).toBeUndefined();
    expect(selections.getScan("id-9")).toBeUndefined();
  });

  it("keeps as many scans as its capacity says", () => {
    const { selections } = store({ capacity: 2 });
    const [a, b, c] = [1, 2, 3].map(() => selections.putScan(SCAN, ROOM, null));
    expect([a, b, c].map((s) => selections.getScan(s.scanId) !== undefined)).toEqual([false, true, true]);
  });
});

describe("SelectionStore: select", () => {
  it("stores the scan's files in the order given, the trimmed matter fields and the digest", () => {
    const { selections } = store();
    const { scanId } = selections.putScan(SCAN, ROOM, null);
    const picked = selections.select(scanId, ["Pleadings/Υπεράσπιση.docx", "Σημειώσεις.pdf"], {
      title: "  Γεωργίου κατά Πέτρου ",
      type: "civil",
      case_reference: " Αρ. Αγωγής 112/2026 ",
      description: "   ",
    });

    expect(picked).toStrictEqual({
      selectionId: "id-2",
      scanId,
      digest: planDigest([
        { ...pathsOf(SCAN.files[2]), sizeBytes: 3_000, kind: "docx", decision: "upload" },
        { ...pathsOf(SCAN.files[0]), sizeBytes: 1_000, kind: "pdf", decision: "upload" },
      ]),
      files: [SCAN.files[2], SCAN.files[0]],
      matter: { title: "Γεωργίου κατά Πέτρου", type: "civil", case_reference: "Αρ. Αγωγής 112/2026" },
    });
    if (!isSelection(picked)) throw new Error("expected a selection");
    expect(picked.files[0]).toBe(SCAN.files[2]);
    expect(selections.getSelection("id-2")).toBe(picked);
    expect(selections.getSelection("id-3")).toBeUndefined();
  });

  it("computes the digest from the selected files' real paths and sizes only, in any order", () => {
    const { selections } = store();
    const { scanId } = selections.putScan(SCAN, ROOM, null);
    const one = selections.select(scanId, ["Σημειώσεις.pdf", "Pleadings/Αγωγή.pdf"], MATTER);
    const other = selections.select(scanId, ["Pleadings/Αγωγή.pdf", "Σημειώσεις.pdf"], MATTER);
    if (!isSelection(one) || !isSelection(other)) throw new Error("expected two selections");
    expect(one.digest).toBe(other.digest);
    expect(one.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(one.selectionId).not.toBe(other.selectionId);
  });

  it("ignores the matter fields in a linked folder", () => {
    const { selections } = store();
    const { scanId } = selections.putScan(SCAN, ROOM, LINK);
    const picked = selections.select(scanId, ["Σημειώσεις.pdf"], { title: "Άλλος τίτλος", type: "appeal" });
    expect(isSelection(picked) && picked.matter).toBeNull();
  });

  it("needs no title in a linked folder", () => {
    const { selections } = store();
    const { scanId } = selections.putScan(SCAN, ROOM, LINK);
    expect(isSelection(selections.select(scanId, ["Σημειώσεις.pdf"], null))).toBe(true);
  });

  it("takes a title of 300 characters", () => {
    const { selections } = store();
    const { scanId } = selections.putScan(SCAN, ROOM, null);
    expect(isSelection(selections.select(scanId, ["Σημειώσεις.pdf"], { title: "α".repeat(300) }))).toBe(true);
  });

  it("takes exactly as many files as the room", () => {
    const { selections } = store();
    const { scanId } = selections.putScan(SCAN, { ...ROOM, room: 2 }, null);
    expect(isSelection(selections.select(scanId, ["Σημειώσεις.pdf", "Pleadings/Αγωγή.pdf"], MATTER))).toBe(true);
  });
});

describe("SelectionStore: refusals", () => {
  const refusal = (room: Room, linked: MatterLink | null, paths: string[], matter: MatterFields | null) => {
    const { selections } = store();
    const { scanId } = selections.putScan(SCAN, room, linked);
    return selections.select(scanId, paths, matter);
  };

  it("refuses a scan id it does not hold, before anything else", () => {
    const { selections } = store();
    selections.putScan(SCAN, ROOM, null);
    expect(selections.select("id-9", [], null)).toStrictEqual({ code: "unknown_scan" });
  });

  it("refuses an empty selection", () => {
    expect(refusal(ROOM, null, [], null)).toStrictEqual({ code: "empty_selection" });
  });

  it("refuses a path that is not in the scan", () => {
    expect(refusal(ROOM, null, ["Σημειώσεις.pdf", "Pleadings/Αγωγή (2).pdf"], MATTER)).toStrictEqual({
      code: "not_in_scan",
      path: "Pleadings/Αγωγή (2).pdf",
    });
  });

  it("refuses a path given twice", () => {
    expect(refusal(ROOM, null, ["Σημειώσεις.pdf", "Pleadings/Αγωγή.pdf", "Σημειώσεις.pdf"], MATTER)).toStrictEqual({
      code: "duplicate_path",
      path: "Σημειώσεις.pdf",
    });
  });

  it.each([
    ["Pleadings/Bundle.pdf", "too_large"],
    ["Old/Αγωγή.pdf", "already_uploaded"],
  ] as const)("refuses an ineligible file, %s, with its reason", (path, reason) => {
    expect(refusal(ROOM, null, ["Σημειώσεις.pdf", path], MATTER)).toStrictEqual({ code: "ineligible", path, reason });
  });

  it("checks each path in turn: the first bad one is the one refused", () => {
    const paths = ["Pleadings/Bundle.pdf", "missing.pdf", "Σημειώσεις.pdf", "Σημειώσεις.pdf"];
    expect(refusal(ROOM, null, paths, MATTER)).toStrictEqual({
      code: "ineligible",
      path: "Pleadings/Bundle.pdf",
      reason: "too_large",
    });
    expect(refusal(ROOM, null, paths.slice(1), MATTER)).toStrictEqual({ code: "not_in_scan", path: "missing.pdf" });
  });

  it("refuses more files than the room, with the count and the room", () => {
    const paths = ["Σημειώσεις.pdf", "Pleadings/Αγωγή.pdf", "Pleadings/Υπεράσπιση.docx"];
    expect(refusal({ ...ROOM, room: 2 }, LINK, paths, null)).toStrictEqual({ code: "over_room", count: 3, room: 2 });
    expect(refusal({ ...ROOM, room: 0 }, LINK, paths.slice(0, 1), null)).toStrictEqual({ code: "over_room", count: 1, room: 0 });
  });

  it("refuses an over-room list before a missing title", () => {
    expect(refusal({ ...ROOM, room: 1 }, null, ["Σημειώσεις.pdf", "Pleadings/Αγωγή.pdf"], null)).toStrictEqual({
      code: "over_room",
      count: 2,
      room: 1,
    });
  });

  it.each([
    ["no matter fields", null],
    ["an empty title", { title: "" }],
    ["a title of spaces", { title: "   " }],
    ["a title of 301 characters", { title: "α".repeat(301) }],
  ])("refuses a new matter with %s", (_what, matter) => {
    expect(refusal(ROOM, null, ["Σημειώσεις.pdf"], matter)).toStrictEqual({ code: "title_required" });
  });

  it("keeps nothing for a refused selection", () => {
    const { selections } = store();
    const { scanId } = selections.putScan(SCAN, ROOM, null);
    expect(selections.select(scanId, ["Σημειώσεις.pdf"], null)).toStrictEqual({ code: "title_required" });
    const picked = selections.select(scanId, ["Σημειώσεις.pdf"], MATTER);
    expect(isSelection(picked) && picked.selectionId).toBe("id-2");
  });
});
