// The init tools of the dikigoros-upload server (0.2.0): a project folder opened as a new DIKIGOROS
// matter, or its new files added to the matter it is linked to, through the project picker widget or
// the init-matter skill's text fallback.
//
//   scan_project         (model) walks the folder read-only and keeps the scan in memory; answers a
//                        compact summary and a scan_id.
//   show_project_picker  (model) renders ui://dikigoros/project-picker for a scan, keeping Claude's
//                        proposal with it; answers a small result, never the tree.
//   load_picker          (app only) answers the picker the whole tree, the limits and the proposal.
//   save_selection       (app only) checks the lawyer's ticks against the scan and keeps them as a
//                        selection: its id and digest are the confirmation init_matter takes.
//   init_matter          (model) opens the matter (or uses the linked one), links the folder to it in
//                        .dikigoros/matter.json before the first upload, then uploads.
//
// scan_project, show_project_picker and init_matter pass the 0.1.0 sign-in gate and the mattersAccess
// check. load_picker and save_selection have no gate and make no request: they read and write the
// helper's memory only, keyed by ids of 128 random bits that only scan_project and save_selection hand
// out, and nothing they answer reaches DIKIGOROS. No result carries a token, and no byte or text of a
// file leaves the computer before init_matter runs with a confirmed selection.

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { CurrentUser, Matter } from "../api/client";
import { ApiError, describeApiError } from "../api/errors";
import { MAX_FILES_PER_CALL, type PlanEntry } from "../files/resolve";
import { type ProjectScan, type ScannedFile, type ScanReason, ScanRootError, type scanProject } from "../files/scan";
import { assignStoredNames } from "../files/stored-names";
import { type LinkedFile, type MatterLink, markUploaded, type readLink, recordOutcome, type writeLink } from "../link/link-file";
import type { DocumentOutcome, UploadContext } from "../pipeline/upload-document";
import {
  PICKER_MATTER_TYPES,
  type PickerFile,
  type PickerInput,
  type PickerReason,
  type SaveSelectionRefusal,
  type SaveSelectionResult,
  type ShowPickerResult,
} from "../shared/picker-contract";
import { firstLine } from "../util";
import { computeRoom, type Room } from "./room";
import type { MatterFields, SelectionRefusal, SelectionStore, StoredScan, StoredSelection } from "./selections";
import {
  answer,
  type CallContext,
  createMatterInput,
  failure,
  failureAfterSignIn,
  formatSize,
  nullOn401,
  progressOf,
  report,
  restartSignIn,
  signInGate,
  stopReason,
  type ToolDeps,
} from "./tools";

/** The picker widget's resource. */
export const PICKER_URI = "ui://dikigoros/project-picker";

export interface InitToolDeps extends ToolDeps {
  scanProject: typeof scanProject;
  links: { read: typeof readLink; write: typeof writeLink };
  /** One store for the process, shared by every connection. */
  selections: SelectionStore;
  homeDir: string;
  /** The built widget HTML. */
  pickerHtml: () => Promise<string>;
  /** Whether this connection's client declared the MCP Apps extension with RESOURCE_MIME_TYPE. */
  uiSupported: () => boolean;
}

/** How many eligible paths scan_project names; the others are counted in their folders. */
export const SHOWN_ELIGIBLE = 300;
/** How many folders scan_project counts one by one. */
const SHOWN_FOLDERS = 100;
/** How many left-over paths init_matter names. */
const SHOWN_LEFT_OVER = 25;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const SHOWS = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const id = z.string().min(1).max(64);
const relativePath = z.string().min(1).max(1024);

const scanProjectInput = z.object({ root: z.string().min(1).max(1024) });

const showProjectPickerInput = z.object({
  scan_id: id,
  matter: createMatterInput.optional(),
  preselect: z.array(relativePath).max(MAX_FILES_PER_CALL).optional(),
});

const loadPickerInput = z.object({ scan_id: id });

// The widget's own call: lenient where the store has a refusal of its own (an empty list, a blank
// title), so the picker gets that refusal as structured content rather than a validation error.
const saveSelectionInput = z.object({
  scan_id: id,
  relative_paths: z.array(z.string().max(1024)).max(MAX_FILES_PER_CALL),
  matter: z
    .object({
      title: z.string().max(1000),
      type: z.enum(PICKER_MATTER_TYPES).optional(),
      case_reference: z.string().max(300).optional(),
      description: z.string().max(2000).optional(),
    })
    .optional(),
});

// One object with every field optional rather than a union of the two shapes, which many clients
// render poorly in tools/list; handleInitMatter tells the shapes apart and refuses a mix of them.
const initMatterInput = z.object({
  selection_id: id.optional(),
  digest: id.optional(),
  root: z.string().min(1).max(1024).optional(),
  relative_paths: z.array(relativePath).min(1).max(MAX_FILES_PER_CALL).optional(),
  matter: createMatterInput.optional(),
  confirm: z.boolean().optional(),
  plan_digest: z.string().max(64).optional(),
});

export type ScanProjectArgs = z.infer<typeof scanProjectInput>;
export type ShowProjectPickerArgs = z.infer<typeof showProjectPickerInput>;
export type LoadPickerToolArgs = z.infer<typeof loadPickerInput>;
export type SaveSelectionToolArgs = z.infer<typeof saveSelectionInput>;
export type InitMatterArgs = z.infer<typeof initMatterInput>;

/** Registers the five init tools and the picker's resource on `server`, all answering with `deps`. */
export function registerInitTools(server: McpServer, deps: InitToolDeps): void {
  server.registerTool(
    "scan_project",
    {
      title: "Scan a project folder",
      description:
        "Use this when the lawyer asks to open a DIKIGOROS matter for a project folder on this computer, or to add " +
        "a linked folder's new files to its matter. Takes the folder's absolute path and walks it read-only: answers " +
        "the eligible files by folder, the room the plan leaves, the linked matter if there is one, and a scan_id " +
        "for show_project_picker or init_matter. Sends nothing about the files to DIKIGOROS. Not for uploading " +
        "named files into a matter (upload_to_matter does that), nor for reading what the files say.",
      inputSchema: scanProjectInput,
      annotations: READ_ONLY,
    },
    (args) => handleScanProject(args, deps),
  );
  registerAppTool(
    server,
    "show_project_picker",
    {
      title: "Show the project picker",
      description:
        "Use this when scan_project has answered a scan_id and the lawyer is to choose the files and confirm the " +
        "matter. Takes the scan_id, the proposed matter fields (a new matter only) and the relative paths to " +
        "preselect, and shows the picker; the lawyer confirms there, and the picker then sends a message with a " +
        "selection_id and digest for init_matter. Not for uploading anything, and not a confirmation by itself.",
      inputSchema: showProjectPickerInput,
      annotations: SHOWS,
      _meta: { ui: { resourceUri: PICKER_URI } },
    },
    (args) => handleShowProjectPicker(args, deps),
  );
  registerAppTool(
    server,
    "load_picker",
    {
      title: "Load the project picker",
      description:
        "Use this when the project picker opens: answers it the scanned tree, the limits and Claude's proposal for " +
        "a scan_id. For the picker only. Not for the model, which has scan_project's summary.",
      inputSchema: loadPickerInput,
      annotations: READ_ONLY,
      _meta: { ui: { resourceUri: PICKER_URI, visibility: ["app"] } },
    },
    (args) => handleLoadPicker(args, deps),
  );
  registerAppTool(
    server,
    "save_selection",
    {
      title: "Save the picker's selection",
      description:
        "Use this when the lawyer confirms in the project picker: checks the ticked files against the scan and the " +
        "limits and keeps them as a selection, answering its selection_id and digest. For the picker only. Not for " +
        "the model, and it uploads nothing.",
      inputSchema: saveSelectionInput,
      annotations: WRITES,
      _meta: { ui: { resourceUri: PICKER_URI, visibility: ["app"] } },
    },
    (args) => handleSaveSelection(args, deps),
  );
  server.registerTool(
    "init_matter",
    {
      title: "Open a matter for a project folder",
      description:
        "Use this when the lawyer has confirmed a selection of a scanned folder's files: with the selection_id and " +
        "digest of the picker's confirmation message, or, where the picker cannot be shown, with the folder's root " +
        "and relative_paths (that first call lists and does nothing; call again with confirm: true and its " +
        "plan_digest). Opens the new matter, or uses the folder's linked one, links the folder to it in " +
        ".dikigoros/matter.json and uploads the files. Not for a selection the lawyer has not confirmed, nor for " +
        "files outside a scanned folder.",
      inputSchema: initMatterInput,
      annotations: WRITES,
    },
    (args, ctx) => handleInitMatter(args, deps, ctx),
  );
  registerAppResource(
    server,
    "DIKIGOROS project picker",
    PICKER_URI,
    {
      description: "The project picker: the lawyer ticks a scanned folder's files and confirms the matter.",
      mimeType: RESOURCE_MIME_TYPE,
      _meta: { ui: { csp: {} } },
    },
    async () => ({
      contents: [{ uri: PICKER_URI, mimeType: RESOURCE_MIME_TYPE, text: await deps.pickerHtml(), _meta: { ui: { csp: {} } } }],
    }),
  );
}

// ---------- scan_project ----------

/**
 * scan_project: the sign-in and the account first; then the scan of `root`, the folder's link file
 * (and, when it names a matter on this base URL, that matter), the room, and the scan kept in the
 * store. With the active-matter limit reached and no usable link, it answers that and keeps nothing.
 */
export async function handleScanProject(args: ScanProjectArgs, deps: InitToolDeps): Promise<CallToolResult> {
  const blocked = await signInGate(deps);
  if (blocked !== null) return blocked;
  try {
    const me = await account(deps);
    if ("result" in me) return me.result;
    const folder = await readFolder(args.root, me.user, deps);
    if ("result" in folder) return folder.result;
    if (folder.linked === null && !folder.room.canCreate) return matterLimit(folder.room, deps);
    const stored = deps.selections.putScan(folder.scan, folder.room, folder.linked);
    return summary(stored, folder.notice, deps);
  } catch (err) {
    return failureAfterSignIn(err, deps.config.baseUrl, "Nothing was changed; try again in a moment.");
  }
}

/** The signed-in user whose plan includes Matters, or the result that answers instead. */
async function account(deps: InitToolDeps): Promise<{ user: CurrentUser } | { result: CallToolResult }> {
  // A 401 from this allowlisted route, after the client's retry with a refreshed token: the session is dead.
  const user = await deps.api.currentUser().catch(nullOn401);
  if (user === null) return { result: await restartSignIn(deps.session) };
  if (!user.entitlements.mattersAccess) {
    return { result: failure(describeApiError(new ApiError(403, "entitlement_required"), deps.config.baseUrl)) };
  }
  return { user };
}

/** A folder as a call finds it: the scan (uploaded files marked), the room, the link and what was wrong with it. */
interface Folder {
  scan: ProjectScan;
  room: Room;
  /** The usable link, with the matter's title as the server has it; null for a new matter. */
  linked: MatterLink | null;
  /** Why a link file present was not used; null when there was none or it was used. */
  notice: string | null;
}

/** The folder at `root`, its link and its room; or an error result for a root the scan refuses. */
async function readFolder(root: string, me: CurrentUser, deps: InitToolDeps): Promise<Folder | { result: CallToolResult }> {
  let scan: ProjectScan;
  try {
    scan = await deps.scanProject(root, { homeDir: deps.homeDir });
  } catch (err) {
    if (err instanceof ScanRootError) return { result: failure(`${ROOT_REFUSALS[err.reason]} Nothing was scanned.`) };
    throw err;
  }
  const open = (await deps.api.listMatters()).filter((matter) => matter.status === "active").length;
  const { baseUrl } = deps.config;
  const read = await deps.links.read(scan.root);
  let linked: MatterLink | null = null;
  let held: number | null = null;
  let notice: string | null = null;
  if (read.kind === "invalid") {
    notice =
      `The folder's link file cannot be used (${read.reason}); a new matter would be opened, ` +
      "and the file is replaced only when init_matter runs.";
  } else if (read.kind === "ok" && read.link.baseUrl !== baseUrl) {
    notice =
      `The folder's link file names matter #${read.link.matterId} on ${read.link.baseUrl}, not on ${baseUrl}; ` +
      "a new matter would be opened here.";
  } else if (read.kind === "ok") {
    const detail = await deps.api.getMatter(read.link.matterId).catch(nullOn404);
    if (detail === null) {
      notice = `The folder's linked matter #${read.link.matterId} is gone (or not yours); a new matter would be opened.`;
    } else {
      linked = { ...read.link, title: detail.matter.title };
      held = detail.documents.length;
      scan = markUploaded(scan, read.link);
    }
  }
  const room = computeRoom({ entitlements: me.entitlements, openMatters: open, linkedHeld: held });
  return { scan, room, linked, notice };
}

const ROOT_REFUSALS: Record<ScanRootError["reason"], string> = {
  not_absolute: "The folder must be given as an absolute path.",
  home_directory: "The home directory, or a folder holding it, is not one project; name the project's own folder.",
  filesystem_root: "A filesystem root is not one project; name the project's own folder.",
  not_a_directory: "That path is a file, not a folder.",
  not_found: "The folder does not exist.",
  unreadable: "The helper may not read that folder (its permissions, or the system's privacy settings).",
};

/** The account may open no more matters, and the folder has none to use. */
function matterLimit(room: Room, deps: InitToolDeps): CallToolResult {
  const { limit, open } = room.activeMatters;
  return failure(
    `The account has ${open} of ${limit} active matters open, the plan's limit, and this folder is not linked to ` +
      `one: archive a matter at ${deps.config.baseUrl}/matters before opening a new one. Nothing was done.`,
  );
}

/** A 404 as null (the matter is gone, or not the lawyer's); any other rejection stands. */
function nullOn404(err: unknown): null {
  if (err instanceof ApiError && err.status === 404) return null;
  throw err;
}

/** The folder a relative path is in: "" for the root. */
function folderOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash === -1 ? "" : relativePath.slice(0, slash);
}

/** How many of `files` each reason has, the reasons sorted. */
function reasonCounts(files: ScannedFile[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) if (file.reason !== undefined) counts.set(file.reason, (counts.get(file.reason) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : 1)));
}

const countsText = (counts: Record<string, number>) =>
  Object.entries(counts)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(", ");

/** The matter facts every answer about a linked folder carries. */
function linkedMatter(link: MatterLink, deps: InitToolDeps) {
  return { id: link.matterId, title: link.title, url: matterUrl(link.matterId, deps) };
}

const matterUrl = (matterId: number, deps: InitToolDeps) => `${deps.config.baseUrl}/matters/${matterId}`;

/** scan_project's answer: the mode, the room, counts by folder and reason, up to SHOWN_ELIGIBLE eligible paths. */
function summary(stored: StoredScan, notice: string | null, deps: InitToolDeps): CallToolResult {
  const { scan, room, linked, scanId } = stored;
  const eligible = scan.files.filter((file) => file.eligible);
  const ineligible = reasonCounts(scan.files);
  const folders = scan.folders
    .filter((folder) => folder.files > 0)
    .map((folder) => {
      const inFolder = scan.files.filter((file) => folderOf(file.relativePath) === folder.relativePath);
      return {
        path: folder.relativePath,
        files: inFolder.length,
        eligible: inFolder.filter((file) => file.eligible).length,
        ineligible: reasonCounts(inFolder),
      };
    });
  const shownFolders = folders.slice(0, SHOWN_FOLDERS);
  const shown = eligible.slice(0, SHOWN_ELIGIBLE);
  const omitted = eligible.length - shown.length;
  const mode = linked === null ? "new" : "linked";
  const lines = [
    linked === null
      ? `Scanned ${scan.root}: a new matter would be opened.`
      : `Scanned ${scan.root}: linked to matter #${linked.matterId} "${linked.title}" (${matterUrl(linked.matterId, deps)}).`,
    ...(notice === null ? [] : [notice]),
    `Room for this call: ${room.room} documents ` +
      (room.perMatter === null ? "(no per-matter limit)." : `(${room.perMatter} per matter, ${room.held} held).`),
    `${eligible.length} of ${scan.files.length} files eligible` +
      (Object.keys(ineligible).length === 0 ? "." : `; not eligible: ${countsText(ineligible)}.`),
    ...(scan.truncated === null ? [] : [truncatedLine(scan.truncated)]),
    "Folders:",
    ...shownFolders.map(({ path, eligible: count, ineligible: reasons }) =>
      [`${path === "" ? "(top level)" : path}: ${count} eligible`, ...(countsText(reasons) ? [countsText(reasons)] : [])].join(", "),
    ),
    ...(folders.length > shownFolders.length ? [`… and ${folders.length - shownFolders.length} more folders`] : []),
    "Eligible files:",
    ...shown.map((file) => `${file.relativePath} · ${formatSize(file.sizeBytes)} · ${file.kind}`),
    ...(omitted > 0 ? [`… and ${omitted} more eligible files, counted in the folders above.`] : []),
    `scan_id: ${scanId}. Next: show_project_picker with this scan_id; where the picker cannot be shown, ` +
      "init_matter with root and relative_paths.",
  ];
  return answer(lines.join("\n"), {
    status: "scanned",
    scan_id: scanId,
    root: scan.root,
    mode,
    ...(linked === null ? {} : { linked_matter: linkedMatter(linked, deps) }),
    ...(notice === null ? {} : { notice }),
    room: {
      room: room.room,
      per_matter: room.perMatter,
      held: room.held,
      active_matters: room.activeMatters,
    },
    counts: { files: scan.files.length, eligible: eligible.length, ineligible },
    folders: shownFolders,
    eligible_files: shown.map((file) => ({ path: file.relativePath, size_bytes: file.sizeBytes, type: file.kind })),
    eligible_files_omitted: omitted,
    truncated: scan.truncated,
  });
}

function truncatedLine(truncated: "depth" | "entries"): string {
  const where = truncated === "depth" ? "8 folders deep" : "5,000 files and folders";
  return `The scan stopped at ${where}; anything past that is not in the scan.`;
}

// ---------- show_project_picker and load_picker ----------

/** A scan this helper does not hold (anymore). */
function unknownScan(scanId: string): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: "This helper holds no scan with that scan_id (it restarted, or newer scans replaced it). Call scan_project again.",
      },
    ],
    structuredContent: { status: "unknown_scan", scan_id: scanId },
    isError: true,
  };
}

/**
 * show_project_picker: the sign-in and the account, then the scan. Where the client shows no
 * widget, it says to go on with the text fallback. Otherwise it keeps the proposal with the scan
 * (the matter fields in a new matter only; the preselection as far as it is in the scan, eligible,
 * named once and within the room) and answers a ShowPickerResult: never the tree, which the picker
 * loads with load_picker.
 */
export async function handleShowProjectPicker(args: ShowProjectPickerArgs, deps: InitToolDeps): Promise<CallToolResult> {
  const blocked = await signInGate(deps);
  if (blocked !== null) return blocked;
  try {
    const me = await account(deps);
    if ("result" in me) return me.result;
  } catch (err) {
    return failureAfterSignIn(err, deps.config.baseUrl, "The picker was not opened; try again in a moment.");
  }
  const stored = deps.selections.getScan(args.scan_id);
  if (stored === undefined) return unknownScan(args.scan_id);
  if (!deps.uiSupported()) {
    return answer(
      "This client cannot show the picker; continue with the text fallback of the init-matter skill " +
        "(init_matter with root and relative_paths).",
      { status: "picker_unavailable", scan_id: args.scan_id },
    );
  }
  const preselect = preselection(stored, args.preselect ?? []);
  const matter = stored.linked === null && args.matter !== undefined ? args.matter : null;
  deps.selections.propose(stored.scanId, { matter, preselect });
  const result: ShowPickerResult = {
    status: "picker_open",
    scan_id: stored.scanId,
    mode: stored.linked === null ? "new" : "linked",
    room: stored.room.room,
    eligible: stored.scan.files.filter((file) => file.eligible).length,
    preselected: preselect.length,
  };
  return answer(
    "The picker is open; the lawyer confirms there. Wait for the confirmation message, then call init_matter with " +
      "the selection_id and digest it gives. Do not call init_matter before it.",
    { ...result },
  );
}

/** The paths of `proposed` that are in the scan and eligible, each once, at most the room of them. */
function preselection(stored: StoredScan, proposed: string[]): string[] {
  const eligible = new Set(stored.scan.files.filter((file) => file.eligible).map((file) => file.relativePath));
  const kept: string[] = [];
  for (const path of proposed) {
    if (kept.length >= stored.room.room) break;
    if (eligible.has(path) && !kept.includes(path)) kept.push(path);
  }
  return kept;
}

/** load_picker: the PickerInput of a scan the store holds. No sign-in and no request: memory only. */
export async function handleLoadPicker(args: LoadPickerToolArgs, deps: InitToolDeps): Promise<CallToolResult> {
  const stored = deps.selections.getScan(args.scan_id);
  if (stored === undefined) return unknownScan(args.scan_id);
  const { scan, room, linked, proposal } = stored;
  const input: PickerInput = {
    scan_id: stored.scanId,
    mode: linked === null ? "new" : "linked",
    root: scan.root,
    ...(linked === null ? {} : { linked_matter: linkedMatter(linked, deps) }),
    room: room.room,
    per_matter: room.perMatter,
    held: room.held,
    ...(linked === null && proposal?.matter ? { matter: proposal.matter } : {}),
    preselect: proposal?.preselect ?? [],
    folders: scan.folders.map((folder) => ({ path: folder.relativePath, depth: folder.depth })),
    files: scan.files.map(pickerFile),
    truncated: scan.truncated,
  };
  return answer(
    `The picker's tree for scan ${stored.scanId}: ${scan.files.length} files in ${scan.folders.length} folders.`,
    { ...input },
  );
}

function pickerFile(file: ScannedFile): PickerFile {
  const row: PickerFile = {
    path: file.relativePath,
    name: file.name,
    size_bytes: file.sizeBytes,
    type: file.kind,
    eligible: file.eligible,
  };
  if (!file.eligible) row.reason = pickerReason(file.reason ?? "unreadable");
  return row;
}

/** A scan's reason as the picker shows it: the ones it names, and "other" for the rest. */
export function pickerReason(reason: ScanReason): PickerReason {
  switch (reason) {
    case "unsupported_type":
    case "too_large":
    case "empty":
    case "unreadable":
    case "outside_directory":
    case "not_found":
    case "already_uploaded":
      return reason;
    default:
      return "other";
  }
}

// ---------- save_selection ----------

/** save_selection: the store's check of the lawyer's ticks; a SaveSelectionResult, or a refusal. No sign-in, memory only. */
export async function handleSaveSelection(args: SaveSelectionToolArgs, deps: InitToolDeps): Promise<CallToolResult> {
  const picked = deps.selections.select(args.scan_id, args.relative_paths, args.matter ?? null);
  if ("code" in picked) return refused(picked);
  const result: SaveSelectionResult = {
    selection_id: picked.selectionId,
    digest: picked.digest,
    count: picked.files.length,
    total_bytes: picked.files.reduce((sum, file) => sum + file.sizeBytes, 0),
  };
  return answer(
    `Selection saved: ${result.count} files, ${formatSize(result.total_bytes)} (selection ${result.selection_id}, ` +
      `digest ${result.digest}).`,
    { ...result },
  );
}

/** A refused selection: its sentence, and the refusal the picker reads. */
function refused(refusal: SelectionRefusal): CallToolResult {
  const content: SaveSelectionRefusal = { refused: refusal.code };
  if ("path" in refusal) content.path = refusal.path;
  return { content: [{ type: "text", text: refusalSentence(refusal) }], structuredContent: { ...content }, isError: true };
}

function refusalSentence(refusal: SelectionRefusal): string {
  switch (refusal.code) {
    case "unknown_scan":
      return "This helper holds no scan with that scan_id (it restarted, or newer scans replaced it). Call scan_project again.";
    case "not_in_scan":
      return `${refusal.path} is not in the scan.`;
    case "ineligible":
      return refusal.reason === "already_uploaded"
        ? `${refusal.path} is already in the matter.`
        : `${refusal.path} cannot be uploaded (${refusal.reason}).`;
    case "duplicate_path":
      return `${refusal.path} is named twice.`;
    case "over_room":
      return `${refusal.count} files are more than the ${refusal.room} this matter has room for in one call.`;
    case "empty_selection":
      return "No file is selected.";
    case "title_required":
      return "The new matter needs a title of 1 to 300 characters.";
  }
}

// ---------- init_matter ----------

const SHAPES =
  "Call init_matter either with selection_id and digest (from the picker) or with root and relative_paths " +
  "(the text fallback), not both.";

/**
 * init_matter. The picker's shape takes only a selection save_selection issued, with its exact
 * digest; the fallback shape scans the folder afresh, checks the paths as save_selection would, and
 * without confirm: true and the plan_digest of that listing lists them and does nothing else. Both
 * then go on in proceed().
 */
export async function handleInitMatter(
  args: InitMatterArgs,
  deps: InitToolDeps,
  request?: CallContext,
): Promise<CallToolResult> {
  const started = deps.now();
  const picker = args.selection_id !== undefined || args.digest !== undefined;
  const fallback = args.root !== undefined || args.relative_paths !== undefined;
  if (picker === fallback) return failure(SHAPES);
  if (picker && (args.selection_id === undefined || args.digest === undefined)) return failure(SHAPES);
  if (fallback && (args.root === undefined || args.relative_paths === undefined)) return failure(SHAPES);

  const blocked = await signInGate(deps);
  if (blocked !== null) return blocked;
  const call = { request, started };
  if (args.selection_id !== undefined) {
    // Memory only, before any request: an id this helper never issued, or a digest not its own, does nothing.
    const selection = deps.selections.getSelection(args.selection_id);
    const stored = selection === undefined ? undefined : deps.selections.getScan(selection.scanId);
    if (selection === undefined || stored === undefined) {
      return refusedInit(
        "unknown_selection",
        "This helper issued no selection with that selection_id (it restarted, or newer scans replaced it). " +
          "Nothing was done; open the picker again.",
      );
    }
    if (selection.digest !== args.digest) {
      return refusedInit("digest_mismatch", "The digest does not match that selection. Nothing was done; open the picker again.");
    }
    try {
      const me = await account(deps);
      if ("result" in me) return me.result;
      return await proceed(stored, selection, me.user, deps, call, "picker");
    } catch (err) {
      return failureAfterSignIn(err, deps.config.baseUrl, "Nothing was uploaded; try again in a moment.");
    }
  }
  try {
    const me = await account(deps);
    if ("result" in me) return me.result;
    const folder = await readFolder(args.root ?? "", me.user, deps);
    if ("result" in folder) return folder.result;
    if (folder.linked === null && !folder.room.canCreate) return matterLimit(folder.room, deps);
    const stored = deps.selections.putScan(folder.scan, folder.room, folder.linked);
    const picked = deps.selections.select(stored.scanId, args.relative_paths ?? [], args.matter ?? null);
    if ("code" in picked) return failure(refusalSentence(picked));
    // confirm: true alone confirms nothing: only the digest says which listing the lawyer approved.
    if (args.confirm !== true || args.plan_digest === undefined) {
      return fallbackListing("confirmation_required", stored, picked, folder.notice, deps);
    }
    if (args.plan_digest !== fallbackDigest(picked)) {
      return fallbackListing("plan_changed", stored, picked, folder.notice, deps);
    }
    return await proceed(stored, picked, me.user, deps, call, "fallback");
  } catch (err) {
    return failureAfterSignIn(err, deps.config.baseUrl, "Nothing was uploaded; try again in a moment.");
  }
}

/**
 * The fallback listing's plan_digest: the selection's digest (the files' real paths and sizes) and the
 * matter fields together, so a confirmed call whose title, type, reference or description differ from
 * the ones the lawyer was shown lists again instead of creating that matter.
 */
function fallbackDigest(picked: StoredSelection): string {
  const matter = picked.matter;
  const fields =
    matter === null
      ? "linked"
      : JSON.stringify([matter.title, matter.type ?? null, matter.case_reference ?? null, matter.description ?? null]);
  return createHash("sha256").update(`${picked.digest}\0${fields}`).digest("hex").slice(0, 16);
}

function refusedInit(status: string, text: string): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: { status }, isError: true };
}

/** The document filename of each selected file (by relative path), the names the link records counting as taken. */
function storedNames(files: ScannedFile[], link: MatterLink | null): Map<string, string> {
  const taken = new Map((link?.files ?? []).map((file) => [file.storedName, file.relativePath]));
  return assignStoredNames(files, taken);
}

/** The text fallback's listing: what a confirmed call would do, and the digest that confirms it. */
function fallbackListing(
  status: "confirmation_required" | "plan_changed",
  stored: StoredScan,
  picked: StoredSelection,
  notice: string | null,
  deps: InitToolDeps,
): CallToolResult {
  const { linked, room } = stored;
  const names = storedNames(picked.files, linked);
  const matter = picked.matter;
  const action =
    linked === null
      ? `open the new matter "${matter?.title ?? ""}" and upload`
      : `upload into matter #${linked.matterId} "${linked.title}"`;
  const files = picked.files.map((file) => ({
    path: file.relativePath,
    size_bytes: file.sizeBytes,
    type: file.kind,
    stored_name: names.get(file.relativePath) ?? file.name,
  }));
  const lines = [
    ...(status === "plan_changed" ? ["The files have changed since they were listed."] : []),
    `Nothing has been created or uploaded. Call again with confirm: true and plan_digest "${fallbackDigest(picked)}" ` +
      `to ${action} the ${files.length} file(s) below.`,
    ...files.map(
      (file) =>
        `${file.path} · ${formatSize(file.size_bytes)} · ${file.type}` +
        (file.stored_name === file.path.split("/").at(-1) ? "" : ` · stored as ${file.stored_name}`),
    ),
    ...(notice === null ? [] : [notice]),
    linked === null
      ? newMatterLine(matter)
      : `Matter #${linked.matterId} "${linked.title}": ${room.held} of ${room.perMatter ?? "∞"} documents`,
  ];
  return answer(lines.join("\n"), {
    status,
    plan_digest: fallbackDigest(picked),
    mode: linked === null ? "new" : "linked",
    ...(linked === null ? { matter } : { linked_matter: linkedMatter(linked, deps) }),
    room: room.room,
    files,
  });
}

function newMatterLine(matter: MatterFields | null): string {
  const details = [
    ...(matter?.type === undefined ? [] : [`type ${matter.type}`]),
    ...(matter?.case_reference === undefined ? [] : [`case reference ${matter.case_reference}`]),
  ];
  return `New matter: "${matter?.title ?? ""}"` + (details.length === 0 ? "" : ` (${details.join(", ")})`);
}

/** What one confirmed call runs with: its request and when it began. */
interface Call {
  request: CallContext | undefined;
  started: number;
}

/** A selected file and how it stands now. */
interface Selected {
  file: ScannedFile;
  sizeBytes: number;
  mtimeMs: number;
}

/**
 * A confirmed selection, in order: every file re-statted (a size changed, or a file gone, lists them
 * again and does nothing); the matter, which is the one the folder's link file names now when it is
 * there on this base URL (so a second run after a failure reuses the matter the first opened),
 * otherwise a new one, the link file written the moment it is created; the stored names; then the
 * uploads, the link file updated after each.
 */
async function proceed(
  stored: StoredScan,
  selection: StoredSelection,
  me: CurrentUser,
  deps: InitToolDeps,
  call: Call,
  shape: "picker" | "fallback",
): Promise<CallToolResult> {
  const root = stored.scan.root;
  const { baseUrl } = deps.config;
  const selected = await restat(selection.files);
  const changed = selection.files.filter((file, i) => selected[i]?.sizeBytes !== file.sizeBytes);
  if (changed.length > 0) return planChanged(changed, selected, selection, shape);
  const current = selected as Selected[];

  // The matter.
  let link: MatterLink | null = null;
  let note: string | null = null;
  const read = await deps.links.read(root);
  if (read.kind === "ok" && read.link.baseUrl === baseUrl) {
    const detail = await deps.api.getMatter(read.link.matterId).catch(nullOn404);
    if (detail !== null) {
      if (stored.linked !== null && stored.linked.matterId !== read.link.matterId) {
        return failure(
          `The folder's link file now names matter #${read.link.matterId}, not #${stored.linked.matterId} as when it ` +
            "was scanned. Nothing was uploaded; scan the folder again.",
        );
      }
      link = { ...read.link, title: detail.matter.title };
      if (stored.linked === null) {
        note = `This folder was linked to matter #${link.matterId} since the scan; the files go there and no new matter is opened.`;
      }
    }
  }
  if (link === null && stored.linked !== null) {
    const same = read.kind === "ok" && read.link.baseUrl === baseUrl && read.link.matterId === stored.linked.matterId;
    return failure(
      same
        ? `The folder's linked matter #${stored.linked.matterId} is gone (or not yours). Nothing was uploaded; ` +
            "scan the folder again to open a new matter."
        : "The folder's link file changed since the scan. Nothing was uploaded; scan the folder again.",
    );
  }
  let created = false;
  if (link === null) {
    if (!stored.room.canCreate) return matterLimit(stored.room, deps);
    if (selection.matter === null) return failure(refusalSentence({ code: "title_required" }));
    const opened = await openMatter(selection.matter, root, deps);
    if ("result" in opened) return opened.result;
    link = opened.link;
    created = true;
  }

  // The uploads.
  const target: MatterLink = link;
  const names = storedNames(selection.files, target);
  const entries = current.map(({ file, sizeBytes }): PlanEntry => ({
    path: file.path,
    realPath: file.realPath,
    name: names.get(file.relativePath) ?? file.name,
    sizeBytes,
    kind: file.kind,
    decision: "upload",
  }));
  const linkState = { link: target, done: 0, failures: 0, reason: "" };
  let outcomes: DocumentOutcome[];
  try {
    outcomes = await uploadAll(entries, me, target.matterId, deps, call, async (i, outcome) => {
      linkState.done += 1;
      const { file, sizeBytes, mtimeMs } = current[i];
      const entry: LinkedFile = {
        relativePath: file.relativePath,
        storedName: entries[i].name,
        sizeBytes,
        mtimeMs,
        sha256: outcome.sha256 ?? null,
        docId: outcome.documentId ?? null,
        status: outcome.status,
      };
      linkState.link = recordOutcome(linkState.link, entry);
      try {
        await deps.links.write(root, linkState.link);
      } catch (err) {
        console.error(`[dikigoros-upload] the link file could not be updated after ${entry.storedName}: ${firstLine(err)}`);
        linkState.failures += 1;
        if (linkState.reason === "") linkState.reason = firstLine(err);
      }
    });
  } catch (err) {
    const why = err instanceof ApiError ? describeApiError(err, baseUrl) : `Could not reach DIKIGOROS (${firstLine(err)}).`;
    return failure(
      `${why} Matter #${target.matterId} (${matterUrl(target.matterId, deps)}) is linked to this folder; ` +
        `${linkState.done} of ${entries.length} files were finished before this. Call init_matter again to resume: ` +
        "files already in the matter come back as duplicates.",
    );
  }

  // The report.
  const reported = await report(target.matterId, outcomes, deps);
  const picked = new Set(selection.files.map((file) => file.relativePath));
  const leftOver = stored.scan.files.filter((file) => file.eligible && !picked.has(file.relativePath));
  const gitignoreHint = await needsGitignore(root);
  const linkWarning =
    linkState.failures === 0
      ? null
      : `The folder's link file could not be updated after ${linkState.failures} files (${linkState.reason}); a later ` +
        "scan may offer them again, and their upload would answer duplicate.";
  const lines = [
    created
      ? `Created matter #${target.matterId} "${target.title}" and linked this folder to it.`
      : `Uploaded into matter #${target.matterId} "${target.title}", linked to this folder.`,
    ...(note === null ? [] : [note]),
    textOfResult(reported),
    ...(leftOver.length === 0 ? [] : [leftOverLine(leftOver)]),
    ...(gitignoreHint ? ["This folder is a git repository and its .gitignore does not list .dikigoros/; offer to add it."] : []),
    ...(linkWarning === null ? [] : [linkWarning]),
  ];
  const facts = (reported.structuredContent ?? {}) as Record<string, unknown>;
  const results = ((facts.results ?? []) as Array<Record<string, unknown>>).map((row, i) => ({
    ...row,
    relative_path: current[i].file.relativePath,
  }));
  return answer(lines.join("\n"), {
    ...facts,
    results,
    matter_created: created,
    matter_id: target.matterId,
    matter_url: matterUrl(target.matterId, deps),
    left_over: leftOver.length,
    left_over_paths: leftOver.slice(0, SHOWN_LEFT_OVER).map((file) => file.relativePath),
    gitignore_hint: gitignoreHint,
    ...(linkWarning === null ? {} : { link_warning: linkWarning }),
  });
}

/** Each file's size and mtime now; null for one that is gone or no longer a file. */
async function restat(files: ScannedFile[]): Promise<Array<Selected | null>> {
  return Promise.all(
    files.map(async (file) => {
      const now = await stat(file.path).catch(() => null);
      return now?.isFile() === true ? { file, sizeBytes: now.size, mtimeMs: now.mtimeMs } : null;
    }),
  );
}

/** The selected files that changed since they were confirmed; nothing was done. */
function planChanged(
  changed: ScannedFile[],
  selected: Array<Selected | null>,
  selection: StoredSelection,
  shape: "picker" | "fallback",
): CallToolResult {
  const nowSize = (file: ScannedFile) => selected[selection.files.indexOf(file)]?.sizeBytes ?? null;
  const lines = [
    "The files have changed since they were confirmed; nothing was created or uploaded.",
    ...changed.map((file) => {
      const now = nowSize(file);
      return `${file.relativePath}: ${now === null ? "gone" : `${formatSize(file.sizeBytes)} → ${formatSize(now)}`}`;
    }),
    shape === "picker"
      ? "Scan the folder again (scan_project) and have the lawyer confirm in the picker again."
      : "Call init_matter again without confirm to list the files as they are now.",
  ];
  return answer(lines.join("\n"), {
    status: "plan_changed",
    changed: changed.map((file) => ({ path: file.relativePath, size_bytes: file.sizeBytes, now_size_bytes: nowSize(file) })),
  });
}

/**
 * POST /api/matters with the confirmed fields, then the link file at once, before any upload, so a
 * failure after the create leaves the folder linked to the matter rather than a second matter on
 * the next run. A link file that cannot be written stops the call before any upload.
 */
async function openMatter(
  fields: MatterFields,
  root: string,
  deps: InitToolDeps,
): Promise<{ link: MatterLink } | { result: CallToolResult }> {
  const { baseUrl } = deps.config;
  let matter: Matter;
  try {
    matter = await deps.api.createMatter({
      title: fields.title,
      matterType: fields.type,
      caseReference: fields.case_reference,
      description: fields.description,
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && err.code !== "not_signed_in") {
      return { result: await restartSignIn(deps.session) };
    }
    const undone = `The matter may not have been created; check ${baseUrl}/matters before trying again. Nothing was uploaded.`;
    return { result: failureAfterSignIn(err, baseUrl, undone) };
  }
  const url = matterUrl(matter.id, deps);
  const link: MatterLink = {
    version: 1,
    baseUrl,
    matterId: matter.id,
    title: matter.title,
    url,
    createdAt: new Date(deps.now()).toISOString(),
    files: [],
  };
  try {
    await deps.links.write(root, link);
  } catch (err) {
    console.error(`[dikigoros-upload] the link file could not be written for matter #${matter.id}: ${firstLine(err)}`);
    return {
      result: failure(
        `Created matter #${matter.id} "${matter.title}" (${url}), but the folder's link file could not be written ` +
          `(${firstLine(err)}); nothing was uploaded. Upload into matter #${matter.id} with upload_to_matter, or fix ` +
          "the folder's permissions first: another init_matter here would open a second matter.",
      ),
    };
  }
  return { link };
}

/**
 * The uploads, as upload_to_matter makes them: the native runtime when a PDF is among them, then
 * one file at a time with a line of progress; between two files, a call that was cancelled or has
 * run past CALL_BUDGET_MS starts no more. `after` is told each outcome, in order, before the next file.
 */
async function uploadAll(
  entries: PlanEntry[],
  me: CurrentUser,
  matterId: number,
  deps: InitToolDeps,
  call: Call,
  after: (index: number, outcome: DocumentOutcome) => Promise<void>,
): Promise<DocumentOutcome[]> {
  const runtimeFailure = entries.some((entry) => entry.kind === "pdf")
    ? await deps.nativeRuntime().then(() => null, firstLine)
    : null;
  const ctx: UploadContext = { baseUrl: deps.config.baseUrl, userId: me.id, matterId };
  const progress = progressOf(call.request);
  const outcomes: DocumentOutcome[] = [];
  for (const [i, entry] of entries.entries()) {
    const stopped = i === 0 ? undefined : stopReason(call.request, deps.now() - call.started);
    let outcome: DocumentOutcome;
    if (stopped !== undefined) {
      outcome = { name: entry.name, status: "skipped", ...stopped };
    } else if (entry.kind === "pdf" && runtimeFailure !== null) {
      outcome = { name: entry.name, status: "failed", code: "native_runtime_unavailable", message: runtimeFailure };
    } else {
      progress?.(`Uploading ${entry.name} (${i + 1} of ${entries.length})`);
      outcome = await deps.upload(entry, ctx, progress);
    }
    outcomes.push(outcome);
    await after(i, outcome);
  }
  return outcomes;
}

function textOfResult(result: CallToolResult): string {
  const [block] = result.content;
  return block?.type === "text" ? block.text : "";
}

function leftOverLine(leftOver: ScannedFile[]): string {
  const shown = leftOver.slice(0, SHOWN_LEFT_OVER).map((file) => file.relativePath);
  const more = leftOver.length - shown.length;
  const head = leftOver.length === 1 ? "1 eligible file was not selected" : `${leftOver.length} eligible files were not selected`;
  return `${head}: ${shown.join(", ")}${more > 0 ? `, … and ${more} more` : ""}`;
}

/** A .gitignore line that keeps .dikigoros out: ".dikigoros", "/.dikigoros/", "**\/.dikigoros/*" and the like. */
const GITIGNORE_LINE = /^\/?(?:\*\*\/)?\.dikigoros(?:\/(?:\*{1,2})?)?$/;

/** Whether the folder is a git repository whose .gitignore does not keep .dikigoros out. Reads only. */
async function needsGitignore(root: string): Promise<boolean> {
  const git = await stat(join(root, ".git")).then(
    () => true,
    () => false,
  );
  if (!git) return false;
  const text = await readFile(join(root, ".gitignore"), "utf8").catch(() => "");
  return !text.split(/\r?\n/).some((line) => GITIGNORE_LINE.test(line.trim()));
}
