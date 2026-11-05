# Plugin 0.2.0 — init a project folder into a new matter, with a file-picker widget — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship plugin 0.2.0: a `dikigoros:init-matter` skill that opens a new DIKIGOROS matter for a project folder and starts the upload, through four new helper tools and an MCP Apps file picker that enforces the plan's limits as the lawyer ticks; with a text fallback where the host shows no widget; plus the one-line main-app allowlist fix the helper's `.txt`/`.md` uploads need.

**Architecture:** The widget picks, the model runs. `scan_project` walks the folder (recursive, read-only) and keeps the scan in the helper's memory; `show_project_picker` renders `ui://dikigoros/project-picker` with Claude's proposed matter fields and preselection; the picker calls the app-only `save_selection`, then posts a confirmation message to the chat; Claude calls `init_matter` with the `selection_id` and digest, which creates the matter, writes `.dikigoros/matter.json` before the first upload, and uploads through the 0.1.0 pipeline. The text fallback calls the same `init_matter` with relative paths and the 0.1.0 list-then-confirm digest. The widget is vanilla TypeScript bundled by esbuild into one self-contained HTML file, committed under `plugins/dikigoros/server/ui/` like the server bundle.

**Tech Stack:** as 0.1.0 (Node ≥ 22.13, `@modelcontextprotocol/server` 2.3.1, zod 4, esbuild, vitest), plus `@modelcontextprotocol/ext-apps` **2.0.4** (exact; `registerAppTool`, `registerAppResource`, `getUiCapability`, `RESOURCE_MIME_TYPE` on the server; `App`, `applyDocumentTheme`, `applyHostStyleVariables` in the widget; `AppBridge` in the test host) and `happy-dom` for the widget's DOM tests.

**Spec:** `docs/superpowers/specs/2026-11-05-plugin-init-matter-design.md` in `dikigoros-ai/dikigoros-ai`, branch `claude/plugin-init-matter` (`git show origin/claude/plugin-init-matter:docs/superpowers/specs/2026-11-05-plugin-init-matter-design.md`). Section numbers below (§n) are that spec's.

## Global Constraints

- Everything in the 0.1.0 plan's Global Constraints still holds (origins, tokens never logged or returned, stdout is JSON-RPC, snake_case tool names with `title`, a "Use this when…" description ending with what the tool is not for, explicit boolean annotations, no legal know-how in tool text, no top-level `bin/` in the plugin).
- The two 0.1.0 tools, `upload_to_matter` and `create_matter`, keep their names, inputs and outputs. Their tests must pass unchanged.
- Limits (§3): room = `docsPerMatter` (new matter) or `docsPerMatter − held` (linked), `-1` meaning unlimited, capped at `MAX_FILES_PER_CALL` (100) per call; `MAX_FILE_BYTES` 50 MB; the accept list unchanged. Enforced in the widget, in `save_selection`, in `init_matter`; the server enforces its own.
- No byte or text of a file leaves the computer before `init_matter` runs with a confirmed selection. `scan_project` and `show_project_picker` call only `GET /auth/current-user`, `GET /api/matters` and (linked folder) `GET /api/matters/{id}`.
- Relative paths are POSIX-style (`/`-separated) everywhere they are stored or shown (the link file, the scan, the widget), on Windows too; absolute paths use the platform's separator.
- The widget's resource declares an empty CSP (`_meta.ui.csp: {}`: no connect, resource or frame domains). The widget never fetches anything; all it knows comes from the tool result and `save_selection`.
- Every widget string exists in English and Greek (`src/ui/strings.ts`); the locale comes from the host context (`el*` → Greek, otherwise English).
- Commit messages: conventional prefix, imperative headline, never `[preview]`, body ends with a blank line and the two attribution lines `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_019KirHChCVxFWe36w5LJLTM`. Subagents commit locally only; no `gh`, no network, no `npm install` (the controller installs in Task 1). Commits are signed (the repository requires it).
- Versions move together to `0.2.0` in Task 14 only (`plugin.json`, the marketplace entry, `package.json`); the build and the CI guard (committed `plugins/` = fresh build) apply to the widget's HTML too.

## Review Focus

1. **A selection the lawyer never confirmed must not upload.** `init_matter` with `selection_id` takes only an id that `save_selection` (app-only) issued, with its exact digest; the fallback shape uploads only with `confirm: true` and the listing's `plan_digest`. Tests in Task 7 cover a guessed id, a wrong digest, and a fallback call without `confirm`.
2. **Symlinks and the root.** A symlinked folder or file whose real path leaves the root's real path is ineligible (`outside_directory`) and its folder never entered; a symlink cycle is entered once; `/`, `C:\` and the home directory itself are refused as roots (Task 2).
3. **The link file before the first upload.** A failure after `POST /api/matters` must leave `.dikigoros/matter.json` naming the new matter, so the next run reuses it rather than creating a second (Task 7 test "a failure after the create leaves the folder linked").
4. **Limits at every layer.** Ticking past the room in the widget is refused (Task 10); `save_selection` refuses an over-room list (Task 6); the fallback `init_matter` refuses one too (Task 7).
5. **Same names from different folders.** `Pleadings/Αγωγή.pdf` and `Old/Αγωγή.pdf` become `Αγωγή.pdf` and `Αγωγή (2).pdf`; a name the link file already holds for another relative path counts as taken (Task 4).

---

## File structure

```
src/files/resolve.ts                     (modified) export resolveCandidate() and kindOf() for the scanner
src/files/scan.ts                        scanProject(root): the recursive, capped, read-only walk
src/files/stored-names.ts                assignStoredNames(): the " (2)" rule
src/link/link-file.ts                    readLink / writeLink (atomic) / markUploaded / recordOutcome
src/pipeline/upload-document.ts          (modified) DocumentOutcome gains sha256 (PDF/DOCX)
src/server/room.ts                       computeRoom(): the limits of §3 from the account, the matters and the link
src/server/selections.ts                 SelectionStore: scans and selections in memory, random ids, newest 8
src/server/init-tools.ts                 scan_project, show_project_picker, save_selection, init_matter + the ui:// resource
src/server/main.ts                       (modified) per-connection UI capability; registers init-tools
src/server/assets.ts                     (modified) resolves server/ui/project-picker.html
src/ui/model.ts                          the picker's pure state: tree, tri-state, room, counter, submit gate
src/ui/strings.ts                        EN/EL dictionary
src/ui/view.ts                           DOM rendering and events over the model
src/ui/main.ts                           App wiring: tool result in, save_selection + sendMessage out, theme
src/ui/styles.css                        host style variables, 44 px targets below 768 px
src/ui/template.html                     the HTML shell the build inlines the script and styles into
plugins/dikigoros/server/ui/project-picker.html   built, committed
plugins/dikigoros/skills/init-matter/SKILL.md     the skill
scripts/build.ts                         (modified) builds the widget HTML
scripts/ui-harness.ts                    local Playwright harness: the picker in an AppBridge host, screenshots
test/support/ui-host.ts                  an in-process AppBridge host for the widget's DOM tests
test/integration/init-flow.test.ts       the whole flow against the fake API
test/plugin-manifest.test.ts             (modified) the skill and the UI file are shipped
docs/assumed-routes.md, README.md, CHANGELOG.md, docs/runbooks/gates/*   (modified/new) Task 13
```

Main repository (`dikigoros-ai/dikigoros-ai`, branch `claude/plugin-init-matter`): Task M1 only.

---

### Task 1: Dependencies and the widget build (controller executes — needs the network)

**Files:** `package.json`, `package-lock.json`, `scripts/build.ts`, `src/ui/template.html`, `src/ui/main.ts` (a stub), `src/server/assets.ts`, `vitest.config.ts`

- [ ] **Step 1:** `npm install --save-exact @modelcontextprotocol/ext-apps@2.0.4` and `npm install --save-dev --save-exact happy-dom@<latest release at least two weeks old>`. Confirm `npm ls @modelcontextprotocol/server @modelcontextprotocol/core` shows one copy of each (ext-apps' peers are `^2.0.0`; the server is 2.3.1).
- [ ] **Step 2:** In `scripts/build.ts`, after the server bundle: `esbuild.build({ entryPoints: ["src/ui/main.ts"], bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, write: false, loader: { ".css": "text" }, legalComments: "eof" })`; read `src/ui/template.html`, replace `/*__STYLES__*/` and `/*__SCRIPT__*/` with the CSS and the JS (escape `</script` as `<\/script`), write `plugins/dikigoros/server/ui/project-picker.html`. Import from `@modelcontextprotocol/ext-apps` (the `.` export); if esbuild cannot resolve its peer imports from the browser entry, use `@modelcontextprotocol/ext-apps/app-with-deps` and record the choice as ruling 2. Add the widget's bundled packages to `THIRD_PARTY_NOTICES.md` through the existing metafile walk (pass the widget build's metafile too).
- [ ] **Step 3:** `src/server/assets.ts`: add `ui: string` = `<server dir>/ui/project-picker.html` to the resolved assets.
- [ ] **Step 4:** `vitest.config.ts`: keep `environment: "node"`; widget DOM tests opt in per file with `// @vitest-environment happy-dom`.
- [ ] **Step 5:** `npm run build && npm run check` → PASS; `git status` shows the new HTML. Commit: `build: bundle the project-picker widget and pin ext-apps 2.0.4`.

---

### Task 2: The project scanner

**Files:** modify `src/files/resolve.ts` (export `resolveCandidate`, `kindOf`; no behaviour change); create `src/files/scan.ts`, `src/files/scan.test.ts`

**Interfaces:**

```ts
export const SCAN_MAX_DEPTH = 8;
export const SCAN_MAX_ENTRIES = 5000;
/** Folder names never entered, besides any name starting with "." */
export const SCAN_SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", "__MACOSX"]);
export type ScanReason = SkipReason | "already_uploaded";
export interface ScannedFile {
  relativePath: string;   // POSIX, from the root, e.g. "Pleadings/Αγωγή.pdf"
  path: string;           // absolute, as reached (root + relative)
  realPath: string;
  name: string;           // basename, verbatim
  sizeBytes: number;
  mtimeMs: number;
  kind: FileKind | null;
  eligible: boolean;
  reason?: ScanReason;    // present exactly when !eligible
}
export interface ScannedFolder { relativePath: string /* "" for the root */; depth: number; files: number; eligible: number }
export interface ProjectScan {
  root: string; realRoot: string;
  files: ScannedFile[];   // sorted by relativePath (folder order, then name), stable across runs
  folders: ScannedFolder[];
  truncated: null | "depth" | "entries";
}
export class ScanRootError extends Error {
  constructor(readonly reason: "not_absolute" | "home_directory" | "filesystem_root" | "not_a_directory" | "not_found" | "unreadable");
}
export async function scanProject(root: string, opts: { homeDir: string }): Promise<ProjectScan>;
```

- [ ] **Step 1: Failing tests** (each under `fs.mkdtemp`):

```ts
it("walks subfolders and gives POSIX relative paths, sorted");
it("keeps Greek and spaced names verbatim in name and relativePath");
it("skips hidden files and folders, node_modules, __MACOSX, .dikigoros and Office lock files (~$x.docx)");
it("marks each ineligible file with the 0.1.0 reason: unsupported_type, empty, too_large, unreadable");
it("refuses a relative root, the home directory, a filesystem root and a file as root (ScanRootError)");
it("follows a symlinked folder that stays inside the root and never enters one that escapes it");
it("marks a symlinked file that escapes the root outside_directory");
it("enters a symlink cycle once");
it("stops at depth 8 with truncated: 'depth' and at 5,000 entries with truncated: 'entries'");
it("counts files and eligible files per folder");
it("reads the filesystem only: the tree is byte-identical after a scan");
```

- [ ] **Step 2:** `npx vitest run src/files/scan` → FAIL.
- [ ] **Step 3: Implement.** Breadth-first from `realpath(root)`; a visited set of real paths for folders; children sorted by name; a folder whose real path does not start with `realRoot + sep` is not entered (no entry); every file goes through `resolveCandidate(path, size, realRoot + sep)` and maps `decision: "upload"` → `eligible: true`; `mtimeMs` from the same `stat`. Entries counted as looked at (files and folders); at `SCAN_MAX_ENTRIES` stop and set `truncated`. Root checks before any walk: `isAbsolute`; `realpath(root)` equal to `realpath(homeDir)` → `home_directory`; `parse(real).root === real` → `filesystem_root`.
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat(files): scan a project folder recursively with caps and symlink containment`.

---

### Task 3: The link file

**Files:** create `src/link/link-file.ts`, `src/link/link-file.test.ts`; modify `src/pipeline/upload-document.ts` (+ its test) to add `sha256?: string` to `DocumentOutcome` for PDF/DOCX (the hash the pipeline already computes).

**Interfaces:**

```ts
export const LINK_DIR = ".dikigoros";
export const LINK_FILE = "matter.json";
export interface LinkedFile {
  relativePath: string; storedName: string; sizeBytes: number; mtimeMs: number;
  sha256: string | null; docId: number | null; status: OutcomeStatus;
}
export interface MatterLink {
  version: 1; baseUrl: string; matterId: number; title: string; url: string; createdAt: string; files: LinkedFile[];
}
export type LinkRead = { kind: "none" } | { kind: "ok"; link: MatterLink } | { kind: "invalid"; reason: string };
export async function readLink(root: string): Promise<LinkRead>;          // zod-validated
export async function writeLink(root: string, link: MatterLink): Promise<void>; // mkdir; temp file in LINK_DIR; rename
/** A copy of `link` with `file`'s entry (by relativePath) replaced or added. */
export function recordOutcome(link: MatterLink, file: LinkedFile): MatterLink;
/** The scan with files the link records as ready or duplicate, same size and mtime, made already_uploaded. */
export function markUploaded(scan: ProjectScan, link: MatterLink): ProjectScan;
```

- [ ] **Step 1: Failing tests:** round trip; `none` when absent; `invalid` for bad JSON, `version: 2`, a missing field; an interrupted write (rename never reached) leaves the old file intact; `recordOutcome` replaces by relative path; `markUploaded` marks only ready/duplicate entries whose size and mtime match, and leaves a changed file eligible; the written JSON never holds a key named like a token (`/token|secret|authorization/i`).
- [ ] **Steps 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat(link): the .dikigoros/matter.json link file`.

---

### Task 4: Stored names

**Files:** create `src/files/stored-names.ts`, `src/files/stored-names.test.ts`

```ts
/** For each selected file, in order, its document filename: the bare name, or with " (n)" before the
 *  extension when an earlier file of this selection or `taken` (storedName → relativePath, from the link)
 *  holds it for another relative path. Compared case-insensitively (NFC). */
export function assignStoredNames(
  selected: ReadonlyArray<{ relativePath: string; name: string }>,
  taken: ReadonlyMap<string, string>,
): Map<string, string>; // relativePath → storedName
```

- [ ] Tests: no clash → bare names; two `Αγωγή.pdf` → `Αγωγή.pdf`, `Αγωγή (2).pdf`; three → `(3)`; a name without extension → `Notes (2)`; `taken` for the same relative path is not a clash (a re-run keeps its name); `taken` for another path is; `Report.PDF` vs `report.pdf` clash. FAIL → implement → PASS. Commit `feat(files): stored names for same-named files from different folders`.

---

### Task 5: Room

**Files:** create `src/server/room.ts`, `src/server/room.test.ts`

```ts
export interface Room {
  perMatter: number | null;   // null = unlimited
  held: number;               // documents in the linked matter; 0 for a new one
  room: number;               // min(perMatter − held, MAX_FILES_PER_CALL); MAX_FILES_PER_CALL when unlimited
  activeMatters: { limit: number | null; open: number };
  canCreate: boolean;         // open < limit (or unlimited)
}
export function computeRoom(input: {
  entitlements: { docsPerMatter: number; activeMatters: number };
  openMatters: number; linkedHeld: number | null; // null: no linked matter
}): Room;
```

- [ ] Tests: Firm new matter → room 50; linked with 44 → 6; linked full → 0; unlimited → 100; 10 of 10 open → `canCreate: false`; a linked matter does not need `canCreate`. Commit `feat(server): the room a matter has for one call`.

---

### Task 6: Scans and selections in memory

**Files:** create `src/server/selections.ts`, `src/server/selections.test.ts`

```ts
export interface StoredScan {
  scanId: string; scan: ProjectScan; room: Room;
  linked: MatterLink | null; createdAt: number;
}
export interface MatterFields { title: string; type?: MatterType; case_reference?: string; description?: string }
export interface StoredSelection {
  selectionId: string; scanId: string; digest: string;
  files: ScannedFile[]; matter: MatterFields | null; // null in re-run mode
}
export type SelectionRefusal =
  | { code: "unknown_scan" } | { code: "not_in_scan"; path: string } | { code: "ineligible"; path: string; reason: ScanReason }
  | { code: "duplicate_path"; path: string } | { code: "over_room"; count: number; room: number }
  | { code: "empty_selection" } | { code: "title_required" };
export class SelectionStore {
  constructor(opts: { capacity?: number /* 8 */; now: () => number; randomId?: () => string /* 16 random bytes, base64url */ });
  putScan(scan: ProjectScan, room: Room, linked: MatterLink | null): StoredScan;
  getScan(scanId: string): StoredScan | undefined;
  select(scanId: string, relativePaths: string[], matter: MatterFields | null): StoredSelection | SelectionRefusal;
  getSelection(selectionId: string): StoredSelection | undefined;
}
```

- [ ] Tests: ids are 22 base64url chars and differ; the 9th scan evicts the oldest and its selections; every refusal code; `matter` ignored (null) when the scan is linked; the digest equals `planDigest` over the selected files' `realPath`/`sizeBytes`. Commit `feat(server): keep scans and confirmed selections in memory`.

---

### Task 7: The four tools and the resource

**Files:** create `src/server/init-tools.ts`, `src/server/init-tools.test.ts`; reuse `signInGate`, `answer`, `failure`, `failureAfterSignIn`, `restartSignIn`, `uploadPlanned`'s loop and `report` from `src/server/tools.ts` (export them; no behaviour change to the 0.1.0 tools).

**Interfaces:**

```ts
export const PICKER_URI = "ui://dikigoros/project-picker";
export interface InitToolDeps extends ToolDeps {
  scanProject: typeof scanProject;
  links: { read: typeof readLink; write: typeof writeLink };
  selections: SelectionStore;
  homeDir: string;
  /** The built widget HTML. */
  pickerHtml: () => Promise<string>;
  /** Whether this connection's client declared the MCP Apps extension with RESOURCE_MIME_TYPE. */
  uiSupported: () => boolean;
}
export function registerInitTools(server: McpServer, deps: InitToolDeps): void;
```

Registration (ext-apps server helpers):

- `registerAppResource(server, "Project picker", PICKER_URI, { description, _meta: { ui: { csp: {} } } }, async () => ({ contents: [{ uri: PICKER_URI, mimeType: RESOURCE_MIME_TYPE, text: await deps.pickerHtml() }] }))`.
- `scan_project` (`registerTool`, `readOnlyHint: true`, `idempotentHint: true`): input `{ root: string(1..1024) }`.
- `show_project_picker` (`registerAppTool`, `_meta: { ui: { resourceUri: PICKER_URI } }`, `readOnlyHint: true`): input `{ scan_id, matter?: MatterFields, preselect?: string[] (≤ 100) }`.
- `save_selection` (`registerAppTool`, `_meta: { ui: { resourceUri: PICKER_URI, visibility: ["app"] } }`, `readOnlyHint: false`): input `{ scan_id, relative_paths: string[] (1..100), matter?: MatterFields }`.
- `init_matter` (`registerTool`, writes): input a zod union `{ selection_id, digest }` | `{ root, relative_paths (1..100), matter?, confirm?, plan_digest? }`.

Behaviour (§4.1–4.4): as the spec. Result texts are operational only. `show_project_picker` without UI support answers text (`status: "picker_unavailable"`) telling the model to continue with the skill's text fallback; with support, text "The picker is open; the lawyer confirms there. Wait for the confirmation message; do not call init_matter before it." and `structuredContent` = `{ mode, root, room, matter, preselect, tree: { folders, files } , truncated }`. `init_matter` answers like `upload_to_matter`'s report plus `matter_created`, `matter_id`, `left_over` (eligible, unselected, not already uploaded) and the `.gitignore` hint when `<root>/.git` exists and `.gitignore` does not list `.dikigoros/`.

- [ ] **Step 1: Failing tests** (fake `ToolDeps` as in `tools.test.ts`; a temp folder for the scans):

```ts
// scan_project
it("starts a sign-in when nobody is signed in, and scans nothing");
it("answers the Firm-plan sentence without mattersAccess");
it("answers the active-matter limit when 10 of 10 are open and the folder is not linked");
it("returns a compact summary: room, per-folder counts, at most 300 eligible paths, and a scan_id");
it("in a linked folder: names the matter, marks uploaded files, room = limit − held");
it("a link file for another base URL, or a matter that answers 404: reported, offers a new matter");
it("makes only GET /auth/current-user, GET /api/matters (and GET /api/matters/{id} when linked)");
// show_project_picker
it("answers picker_unavailable when the client has no MCP Apps support");
it("drops preselected paths that are not in the scan, ineligible or over the room");
it("carries the full tree in structuredContent and is linked to ui://dikigoros/project-picker");
it("answers unknown_scan for a scan_id it does not hold");
// save_selection
it("is listed with visibility ['app'] only");
it("returns selection_id and digest for a valid selection");
it("refuses each SelectionRefusal with its sentence");
// init_matter, picker shape
it("refuses a selection_id it never issued, and a digest that does not match");
it("creates the matter, writes the link file BEFORE the first upload, then uploads and records each outcome");
it("a failure after the create leaves the folder linked to the new matter");
it("in a linked folder: creates no matter and uploads into the linked one");
it("re-lists (plan_changed) when a selected file's size changed since the selection");
it("names same-named files Αγωγή.pdf and Αγωγή (2).pdf");
it("stops between files when cancelled or over the 20-minute budget, as upload_to_matter does");
// init_matter, fallback shape
it("without confirm: lists, uploads nothing, creates nothing");
it("with confirm and the listing's plan_digest: creates and uploads");
it("refuses an over-room list, an ineligible path and a path outside the scan");
// resource
it("serves the HTML with mimeType text/html;profile=mcp-app and an empty CSP");
```

- [ ] **Steps 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat(server): scan_project, show_project_picker, save_selection, init_matter and the picker resource`.

---

### Task 8: Server wiring and the UI capability

**Files:** modify `src/server/main.ts`; extend `test/plugin-smoke.test.ts`

- [ ] **Step 1:** In `serve()`, one `SelectionStore` for the process (shared by every connection); inside the `serveStdio` factory: `let ui = false; server.server.oninitialized = () => { ui = getUiCapability(server.server.getClientCapabilities())?.mimeTypes?.includes(RESOURCE_MIME_TYPE) === true; };` then `registerTools(server, deps)` and `registerInitTools(server, { ...deps, scanProject, links, selections, homeDir: homedir(), pickerHtml: once(() => readFile(assets.ui, "utf8")), uiSupported: () => ui })`.
- [ ] **Step 2:** Smoke test: start the built bundle, `initialize` once with `capabilities.extensions["io.modelcontextprotocol/ui"] = { mimeTypes: ["text/html;profile=mcp-app"] }` and once without; `tools/list` shows the six model-visible tools (`save_selection` carries `visibility: ["app"]`); `resources/read ui://dikigoros/project-picker` returns HTML that contains `<script` and no `http://` or `https://` URL except inside comments.
- [ ] **Step 3:** `npm run build && npm test` → PASS. Commit `feat(server): register the init tools and detect MCP Apps support per connection`.

---

### Task 9: The picker's model

**Files:** create `src/ui/model.ts`, `src/ui/model.test.ts`

```ts
export interface PickerInput { /* = show_project_picker's structuredContent */ }
export type CheckState = "checked" | "unchecked" | "mixed" | "disabled";
export class PickerModel {
  constructor(input: PickerInput);
  readonly room: number;
  selectedCount(): number; selectedBytes(): number;
  fileState(relativePath: string): CheckState;
  folderState(relativePath: string): CheckState;
  /** Toggles a file; refused (returns { refused: "over_room" }) when it would pass the room. */
  toggleFile(relativePath: string): { ok: true } | { refused: "over_room" | "ineligible" | "already_uploaded" };
  /** Ticks the folder's eligible, not-uploaded files in order up to the room, or clears them when all are ticked. */
  toggleFolder(relativePath: string): { ok: true; added: number; leftOut: number };
  resetToSuggested(): void; clear(): void;
  setMatter(fields: Partial<MatterFields>): void;
  canSubmit(): { ok: true } | { ok: false; why: "title_required" | "nothing_selected" | "over_room" };
  selection(): { relative_paths: string[]; matter: MatterFields | null };
}
```

- [ ] Tests: the preselection is ticked at start; counter and bytes; a 51st tick refused at room 50; a folder tick stops at the room and reports `leftOut`; mixed state; ineligible and already-uploaded never tickable; `canSubmit` for each reason; re-run mode returns `matter: null`. Commit `feat(ui): the project picker's state model`.

---

### Task 10: The picker's view and app wiring

**Files:** create `src/ui/strings.ts`, `src/ui/view.ts`, `src/ui/main.ts`, `src/ui/styles.css`, `src/ui/template.html`, `test/support/ui-host.ts`, `src/ui/view.test.ts` (`// @vitest-environment happy-dom`)

- [ ] **Step 1:** `test/support/ui-host.ts`: an `AppBridge` host (from `@modelcontextprotocol/ext-apps/app-bridge`) connected to the widget through an in-memory `postMessage` pair, with host context `{ locale, theme }`, that delivers a tool result, answers `tools/call save_selection` from a stub, and records `ui/message` requests.
- [ ] **Step 2: Failing tests:**

```ts
it("renders the matter fields prefilled, the tree, the counter '12 / 50 documents · 34.2 MB'");
it("renders Greek strings when the host locale is el-CY, English for en-GB");
it("greys an ineligible row with its reason and an already-uploaded row as uploaded");
it("refuses a tick past the room with a notice naming the limit");
it("folder checkbox: tri-state; ticks up to the room");
it("disables the main button for an empty title, an empty selection, an over-room selection");
it("re-run mode: shows 'Adding to matter #12 “…”' read-only and the button 'Upload to matter #12'");
it("submit: calls save_selection with the paths and fields, then sends one ui/message with selection_id and digest, then shows 'Sent to Claude'");
it("a save_selection refusal is shown and the picker stays editable");
it("keyboard: arrow keys move through the tree, space ticks; the counter is in an aria-live region");
it("a truncated scan shows the truncation notice");
```

- [ ] **Step 3: Implement.** `main.ts`: `const app = new App({ name: "dikigoros-project-picker", version })`; `app.ontoolresult = ({ structuredContent }) => render(new PickerModel(structuredContent))`; `app.onhostcontextchanged` → `applyDocumentTheme`, `applyHostStyleVariables`, locale; submit → `app.callServerTool({ name: "save_selection", arguments })` then `app.sendMessage({ role: "user", content: [{ type: "text", text: strings.confirmMessage(...) }] })`. The confirmation text names the matter title (or `#id`), the count, the `selection_id` and the digest, in the host's language, and ends with "Run init_matter with this selection." `view.ts` builds the DOM with `document.createElement` only (no `innerHTML` with data). `styles.css` uses the host's CSS variables with fallbacks; `@media (max-width: 767px)` row and button height 44 px.
- [ ] **Step 4:** `npm run build && npx vitest run src/ui` → PASS. Commit `feat(ui): the project picker widget`.

---

### Task 11: The skill

**Files:** create `plugins/dikigoros/skills/init-matter/SKILL.md`; modify `test/plugin-manifest.test.ts`

- [ ] **Step 1:** `SKILL.md` frontmatter: `name: init-matter`; `description:` "Use when the lawyer wants a project folder set up as a new DIKIGOROS matter and its files uploaded — e.g. 'set this folder up as a matter', 'open a new matter for this case and upload the files', 'άνοιξε νέα υπόθεση για αυτό τον φάκελο', or re-running it in a folder already linked to a matter. Not for searching case law or for uploading to a matter not linked to the folder (use upload_to_matter)."; `argument-hint: "[folder]"`. Body: §7 steps 1–6 as instructions to Claude, with the exact tool names and the stop-and-wait rule in bold; the preselection guidance (document kinds and name patterns, EN and EL) as operational naming heuristics only; the fallback with AskUserQuestion where available. No legal analysis.
- [ ] **Step 2:** Manifest test: the skill file exists, its frontmatter parses, `name` is `init-matter`, the description is ≤ 1024 characters; the body names `scan_project`, `show_project_picker` and `init_matter` and never `save_selection` (the model must not call it); `plugins/dikigoros/server/ui/project-picker.html` exists.
- [ ] **Step 3:** `claude plugin validate ./plugins/dikigoros` (controller, if the CLI is available) → valid. Commit `feat(skill): dikigoros:init-matter`.

---

### Task 12: The whole flow against the fake API

**Files:** create `test/integration/init-flow.test.ts` (patterned on `upload-flow.test.ts`)

- [ ] A folder `Παπαδόπουλος v Γεωργίου/` with `Pleadings/Αγωγή.pdf`, `Pleadings/Υπεράσπιση.docx`, `Old/Αγωγή.pdf` (different bytes), `notes.md`, `big.pdf` (50 MB + 1, sparse), `photo.jpg`, `.DS_Store`, `node_modules/x.pdf`:
  1. `scan_project` → requests recorded: `GET /auth/current-user`, `GET /api/matters` only; four eligible, `big.pdf` too_large, `photo.jpg` unsupported_type.
  2. `show_project_picker` with UI support → structuredContent tree.
  3. `save_selection` of the four → id + digest.
  4. `init_matter` → `POST /api/matters`, the link file present before the first `…/upload`, the five upload request sequences of 0.1.0's shape, `Αγωγή (2).pdf` for `Old/Αγωγή.pdf`, the link file listing four ready files with sha256 for the PDFs and DOCX.
  5. Re-run: `scan_project` in the same folder → linked mode, four already_uploaded, room 46; add `Pleadings/Ένορκη δήλωση.pdf`; the fallback `init_matter` without confirm lists one file; with confirm uploads it into the same matter, no `POST /api/matters`.
- [ ] Commit `test: the init-matter flow end to end against the fake API`.

---

### Task 13: Documentation and gates

**Files:** `README.md`, `docs/assumed-routes.md`, `CHANGELOG.md` (0.2.0 entry, unreleased), `docs/runbooks/gates/MIKE-TODO.md`, `docs/runbooks/gates/2026-10-20-03-marketplace-smoke-test.md` (extended), `docs/runbooks/gates/2026-11-05-04-plugin-directory-submission.md` (new), `scripts/ui-harness.ts`

- [ ] README: the skill, the picker and the fallback; the link file and the `.gitignore` advice; what leaves the computer (unchanged, plus: the scan sends nothing about the files).
- [ ] `assumed-routes.md`: `GET /api/matters` now called (by `scan_project`); `POST …/documents/text` allowlisted by the main app's PR (Task M1) — remove its "not allowlisted" warning once that PR is merged; the PATCH stays not allowlisted by the owner's decision of 2026-11-05.
- [ ] Gate 03: add steps — in Cowork, `/dikigoros:init-matter` on a real folder with subfolders: the picker renders (**record whether a local plugin server's MCP App renders at all**), the counter and the room refusal work, submit → upload → link file; in the Claude Code CLI, the same through the text fallback; a re-run offers only new files; both languages.
- [ ] Gate 04 (new): the directory submission checklist — listing name and one-line description EN/EL, long description, category `legal`, screenshots (picker EN and EL, fallback in the CLI, the matter page after upload), privacy URL `https://dikigoros.ai/privacy`, terms URL `https://dikigoros.ai/terms`, support contact, the data-flow statement, the repository URL and licence, the version; prerequisites: gates 01, 09 and 03 done, 0.2.0 tagged.
- [ ] `scripts/ui-harness.ts` (local only; `require("playwright")`, Chromium and WebKit): serves the built HTML in an `AppBridge` host page with a fixture tool result, screenshots at 375 / 768 px, EN and EL, light and dark, into a gitignored `ui-harness-out/`; `.gitignore` gains `ui-harness-out/`.
- [ ] Commit `docs: init-matter, the picker, gates 03 and 04`.

---

### Task 14: Version 0.2.0 and the release checks (controller)

- [ ] `0.2.0` in `plugins/dikigoros/.claude-plugin/plugin.json`, the marketplace entry and `package.json`; the `plugin.json` description mentions setting up a project folder as a matter; the CHANGELOG entry dated.
- [ ] `npm run build`, `npm run check`, `claude plugin validate ./plugins/dikigoros`, `claude plugin validate .`; `git status --porcelain -- plugins/` empty after the commit.
- [ ] Run `scripts/ui-harness.ts`; look at every screenshot (Chromium and WebKit, EN and EL, 375 and 768, light and dark); attach them to the PR.
- [ ] Commit `chore(release): 0.2.0`; push the branch; open the PR (owner merges; the tag `v0.2.0` goes on the merge commit after gate 03).

---

### Task M1: The main app — allowlist the text route (repository `dikigoros-ai/dikigoros-ai`)

**Files:** `lib/mcp/auth.ts`, `lib/mcp/auth.test.ts`, `docs/reference/api-routes.md` (the connector-token allowlist row), `app/(public)/connect/…` plugin card copy and its EN/EL dictionary strings, `graphify-out/` (`graphify update .`)

- [ ] **Step 1: Failing test** in `lib/mcp/auth.test.ts`: `connectorTokenAllowed("POST", "/api/matters/12/documents/text", ["matters:write"])` is true; with only `matters:read` false; `PATCH /api/matters/12/documents/3` stays false with `matters:write`.
- [ ] **Step 2:** Add `{ method: "POST", pattern: /^\/api\/matters\/\d+\/documents\/text$/, scope: "matters:write" }` to `CONNECTOR_TOKEN_ROUTES`. PASS.
- [ ] **Step 3:** The `/connect` plugin card: one sentence on `/dikigoros:init-matter` in both dictionaries (no corpus count: `lib/i18n.counts.test.ts`).
- [ ] **Step 4:** Docs row; `graphify update .`; `npm run lint && npx vitest run lib/mcp`.
- [ ] **Step 5:** Verification per CLAUDE.md: `MCP_ENABLED=true npm run dev`, `/connect` renders the card in EN and EL; the mobile audit for `/connect` at 375 / 414 / 768, EN + EL, Chromium and WebKit; restore the baseline directory after.
- [ ] **Step 6:** Commit `fix(mcp): accept connector tokens on POST /api/matters/[id]/documents/text`; PR to `main` (the owner merges; production picks it up on merge, before gate 03).

---

## Appendix — rulings taken while planning (each reversible)

1. **Vanilla TypeScript widget**, no React: one small self-contained file, no extra peer dependency, nothing the host does not need.
2. **`@modelcontextprotocol/ext-apps` 2.0.4 exact** (published 2026-10-27; 2.1.0 came out the same day and is skipped until it has aged). Import path `.` unless the browser build needs `app-with-deps` (Task 1).
3. **DOM tests in CI with happy-dom; Playwright only in a local harness** (`scripts/ui-harness.ts`): CI stays offline and browser-free as in 0.1.0; the cross-engine look is checked by eye at release (Task 14) and on the real hosts at gate 03.
4. **`show_project_picker` is registered for every client** and answers text where the client declared no MCP Apps support, so the tool list does not change with the host and the skill has one branch to read.
5. **The confirmation is the widget's `ui/message`**, carrying `selection_id` and digest; `init_matter` trusts only ids `save_selection` issued in this process. A restart of the helper loses the selection, and the skill reopens the picker.
6. **Scans and selections live in memory**, newest 8 scans; nothing about the folder is written anywhere but the link file, and that only by `init_matter`.
7. **`DocumentOutcome.sha256`** is added for PDF/DOCX (the pipeline has it already); text documents record `null`, the server hashing their normalised text.
8. **Relative paths are POSIX in storage and display**, so a link file made on Windows reads on macOS.
9. **Hidden entries, `node_modules`, `__MACOSX` and `~$` lock files are skipped silently** (no row in the picker), as 0.1.0 skips dotfiles in a listing.
10. **The PATCH stays off the allowlist** (owner, 2026-11-05); the picker sets no role or side.
