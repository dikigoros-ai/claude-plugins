// The whole init-matter flow as the dikigoros-upload server runs it, against the in-memory DIKIGOROS
// API and private blob store of ../support/fake-api: scan_project, show_project_picker, the picker's
// load_picker and save_selection, then init_matter, over a real project folder, through the real
// scanner, link file, selection store, REST client, blob upload, PDF extraction (pdf.js with the dev
// @napi-rs/canvas and pdf.js's own assets), DOCX extraction and document pipeline. Then the re-run
// of the same folder: linked to the matter the first run opened, a new file added through the text
// fallback. Only the sign-in is a stub, as in upload-flow.test.ts. What is checked is what reached
// the fake (the requests, in order, their bodies, the blobs) and what is on disk in the folder.

import type { CallToolResult } from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { uploadBlob } from "../../src/api/blob-upload";
import { DikigorosApi } from "../../src/api/client";
import { DEVICE_SCOPES, type HelperConfig } from "../../src/config";
import { extractDocx } from "../../src/extract/docx";
import { extractPdf, type PdfAssets } from "../../src/extract/pdf";
import { MAX_FILE_BYTES, resolveUploadPlan } from "../../src/files/resolve";
import { scanProject } from "../../src/files/scan";
import { LINK_DIR, LINK_FILE, type MatterLink, readLink, writeLink } from "../../src/link/link-file";
import type { CanvasModule } from "../../src/native/load";
import { uploadDocument, type UploadDeps } from "../../src/pipeline/upload-document";
import {
  handleInitMatter,
  handleLoadPicker,
  handleSaveSelection,
  handleScanProject,
  handleShowProjectPicker,
  type InitToolDeps,
} from "../../src/server/init-tools";
import { SelectionStore } from "../../src/server/selections";
import type { SessionLike } from "../../src/server/tools";
import type { PickerInput, SaveSelectionResult, ShowPickerResult } from "../../src/shared/picker-contract";
import { makeDocx } from "../support/docx-fixture";
import { FAKE_USER, type FakeApi, type RecordedRequest, startFakeApi, TEST_TOKEN } from "../support/fake-api";
import { textPdf } from "../support/pdf-fixtures";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PDFJS_DIR = join(ROOT, "node_modules", "pdfjs-dist");
const canvas = createRequire(import.meta.url)("@napi-rs/canvas") as CanvasModule;
const assets: PdfAssets = {
  workerSrc: pathToFileURL(join(PDFJS_DIR, "legacy", "build", "pdf.worker.min.mjs")).href,
  wasmUrl: `${join(PDFJS_DIR, "wasm")}/`,
  standardFontDataUrl: `${join(PDFJS_DIR, "standard_fonts")}/`,
};

/** Where the fake store's blobs live: its private host. */
const STORE = "https://teststore.private.blob.vercel-storage.com/";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** The project folder's name, which the picker proposes as the matter's title too. */
const PROJECT = "Παπαδόπουλος v Γεωργίου";
const MATTER = { title: PROJECT, type: "civil", case_reference: "Αγωγή αρ. 123/2026" } as const;

const CLAIM = "Pleadings/Αγωγή.pdf";
const DEFENCE = "Pleadings/Υπεράσπιση.docx";
/** A second Αγωγή.pdf, from another folder and with other bytes: a one-page CCITT G4 scan, so OCR. */
const OLD_CLAIM = "Old/Αγωγή.pdf";
const NOTES = "notes.md";
/** Added before the re-run. */
const AFFIDAVIT = "Pleadings/Ένορκη δήλωση.pdf";

/** The PDF fixtures take ASCII only: the Greek is in the file names. */
const CLAIM_LINES = ["Statement of claim in Papadopoulos v Georgiou,", "with a text layer long enough to need no OCR."];
const CLAIM_TEXT = "Statement of claim in Papadopoulos v Georgiou, with a text layer long enough to need no OCR.";
const AFFIDAVIT_LINES = ["Affidavit in support of the claim,", "sworn before the registrar of the court."];
const AFFIDAVIT_TEXT = "Affidavit in support of the claim, sworn before the registrar of the court.";
const DEFENCE_PARAGRAPHS = ["ΥΠΕΡΑΣΠΙΣΗ", "Η υπεράσπιση του εναγομένου, σε δύο παραγράφους."];
/** Υπεράσπιση.docx as mammoth reads it: each paragraph followed by a blank line. */
const DEFENCE_TEXT = "ΥΠΕΡΑΣΠΙΣΗ\n\nΗ υπεράσπιση του εναγομένου, σε δύο παραγράφους.\n\n";
/** notes.md as written: Greek Markdown with CRLF line ends and a trailing blank line. */
const NOTES_MD = "# Σημειώσεις\r\n\r\nΕπόμενη δικάσιμος: 12 Νοεμβρίου.\r\n\r\n";
/** notes.md as the text route must receive it: LF line ends, the ends trimmed. */
const NOTES_TEXT = "# Σημειώσεις\n\nΕπόμενη δικάσιμος: 12 Νοεμβρίου.";

/** The four files the lawyer confirms, in the order save_selection is given them. */
const FOUR = [CLAIM, DEFENCE, OLD_CLAIM, NOTES];

/** A session that always holds the fake's token and must never be asked to sign in or out. */
const SESSION: SessionLike = {
  getAccessToken: async () => TEST_TOKEN,
  beginSignIn: async () => {
    throw new Error("beginSignIn must not be called");
  },
  forgetSession: async () => {
    throw new Error("forgetSession must not be called");
  },
};

let tmp: string;
/** The project folder: `PROJECT` inside the temporary directory. */
let folder: string;
/** The bytes of each file written, by relative path. */
const files: Record<string, Uint8Array> = {};

let fake: FakeApi;
let helper: InitToolDeps;
/**
 * The link file as it stood on disk when the helper sent its first …/documents/upload request, and
 * the requests the fake had answered by then; undefined until that request is sent.
 */
let atFirstUpload: { link: unknown; before: string[] } | undefined;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "dikigoros-init-flow-"));
  folder = join(tmp, PROJECT);
  await mkdir(join(folder, "Pleadings"), { recursive: true });
  await mkdir(join(folder, "Old"));
  await mkdir(join(folder, "node_modules"));
  await mkdir(join(tmp, "home"));
  files[CLAIM] = textPdf(CLAIM_LINES);
  files[DEFENCE] = await makeDocx(DEFENCE_PARAGRAPHS);
  files[OLD_CLAIM] = await readFile(join(ROOT, "test", "fixtures", "ccitt-g4.pdf"));
  files[NOTES] = new TextEncoder().encode(NOTES_MD);
  files["photo.jpg"] = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  files[".DS_Store"] = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x42, 0x75, 0x64, 0x31]);
  files["node_modules/x.pdf"] = textPdf(["A PDF inside node_modules, which the scan never enters."]);
  for (const [path, bytes] of Object.entries(files)) await writeFile(join(folder, path), bytes);
  // One byte over the limit, and sparse: a PDF header, then a hole to 50 MB + 1.
  await writeFile(join(folder, "big.pdf"), "%PDF-1.7\n");
  await truncate(join(folder, "big.pdf"), MAX_FILE_BYTES + 1);

  // One fake for the whole flow: the re-run finds the matter the first run opened.
  fake = await startFakeApi();
  // Read by the blob SDK on every upload: the fake's store, and every store failure final at once.
  vi.stubEnv("VERCEL_BLOB_API_URL", `${fake.baseUrl}/blob-store`);
  vi.stubEnv("VERCEL_BLOB_RETRIES", "0");
  helper = helperFor(fake.baseUrl);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await fake.close();
  await rm(tmp, { recursive: true, force: true });
});

/**
 * The init tools' dependencies as src/server/main.ts wires them, against `baseUrl`: the real modules
 * throughout (scanner, link file, selection store, client, pipeline), but for the stub session, the
 * native runtime of the dev dependencies, a sleep that does not wait between polls, a client that
 * declared MCP Apps support, and a picker HTML nobody reads here. The client's fetch looks at the disk
 * before the first upload-token request goes out.
 */
function helperFor(baseUrl: string): InitToolDeps {
  const config: HelperConfig = {
    baseUrl,
    audience: `${baseUrl}/mcp`,
    auth0Domain: "auth0.invalid", // never reached: the session is a stub
    auth0ClientId: "test",
    scopes: DEVICE_SCOPES,
    dataDir: join(tmp, "data"),
    openBrowser: false,
    nativeDirOverride: null,
  };
  const api = new DikigorosApi({
    baseUrl,
    getToken: async () => TEST_TOKEN,
    onUnauthorized: async () => TEST_TOKEN,
    fetchImpl: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (atFirstUpload === undefined && url.pathname.endsWith("/documents/upload")) {
        const link = await readFile(linkPath(), "utf8").then(JSON.parse, () => null);
        atFirstUpload = { link, before: fake.requests.map(step) };
      }
      return fetch(input, init);
    },
  });
  const pipeline: UploadDeps = {
    api,
    uploadBlob,
    extractPdf: (bytes, onProgress) => extractPdf(bytes, { canvas, assets, onProgress }),
    extractDocx,
    readFile: (path) => readFile(path),
    sleep: async () => {},
    now: Date.now,
    pollIntervalMs: 10,
    // A fake that never finishes a document fails the test in seconds, not in ten minutes.
    maxWaitMs: 10_000,
    log: () => {},
  };
  return {
    config,
    session: SESSION,
    api,
    resolvePlan: resolveUploadPlan,
    upload: (entry, ctx, onProgress) => uploadDocument(entry, ctx, { ...pipeline, onProgress }),
    nativeRuntime: async () => ({ nodeModulesDir: join(ROOT, "node_modules") }),
    tokenStoreWarning: async () => null,
    now: Date.now,
    scanProject,
    links: { read: readLink, write: writeLink },
    selections: new SelectionStore({ now: Date.now }),
    homeDir: join(tmp, "home"),
    pickerHtml: async () => "<!doctype html><title>picker</title>",
    uiSupported: () => true,
  };
}

const linkPath = () => join(folder, LINK_DIR, LINK_FILE);

/** The link file as it is on disk now. */
async function linkOnDisk(): Promise<MatterLink> {
  return JSON.parse(await readFile(linkPath(), "utf8")) as MatterLink;
}

/** The result's structuredContent; fails the test, with the result's text, on an error result. */
function structured<T>(result: CallToolResult): T {
  const [first] = result.content;
  expect(result.isError, first?.type === "text" ? first.text : undefined).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain(TEST_TOKEN);
  return result.structuredContent as T;
}

/**
 * One request as a line: `METHOD path`, the pathname a client token was asked for, the store's PUT
 * as the pathname it put, and the status when the fake refused it.
 */
function step(request: RecordedRequest): string {
  const refused = request.status >= 400 ? ` → ${request.status}` : "";
  if (request.blob !== undefined) return `PUT store ${request.blob.pathname}${refused}`;
  const payload = (request.body as { payload?: { pathname?: string } } | undefined)?.payload;
  const token = request.path.endsWith("/documents/upload") ? ` for ${payload?.pathname}` : "";
  return `${request.method} ${request.path}${token}${refused}`;
}

/** Runs `call` and gives back its result and the requests the fake answered while it ran. */
async function recording<T>(call: () => Promise<T>): Promise<{ result: T; requests: RecordedRequest[] }> {
  const sent = fake.requests.length;
  const result = await call();
  return { result, requests: fake.requests.slice(sent) };
}

/** The bodies of the requests to `method path` among `requests`, in the order they were sent. */
function bodiesOf(requests: RecordedRequest[], method: string, path: string): unknown[] {
  return requests.filter((request) => request.method === method && request.path === path).map(({ body }) => body);
}

/** The URL the store answered for its one PUT of `pathname` among `requests`. */
function storedUrl(requests: RecordedRequest[], pathname: string): string {
  const urls = requests.filter((request) => request.blob?.pathname === pathname).map(({ answer }) => (answer as { url: string }).url);
  expect(urls, pathname).toHaveLength(1);
  return urls[0];
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** scan_project's answer, as far as the flow reads it. */
interface Summary {
  status: string;
  scan_id: string;
  root: string;
  mode: "new" | "linked";
  linked_matter?: { id: number; title: string; url: string };
  room: { room: number; per_matter: number | null; held: number; active_matters: { limit: number | null; open: number } };
  counts: { files: number; eligible: number; ineligible: Record<string, number> };
  folders: Array<{ path: string; files: number; eligible: number; ineligible: Record<string, number> }>;
  eligible_files: Array<{ path: string; size_bytes: number; type: string }>;
}

/** init_matter's report of a confirmed call. */
interface InitReport {
  status: string;
  matter_created: boolean;
  matter_id: number;
  left_over: number;
  results: Array<{ relative_path: string; name: string; status: string; doc_id?: number }>;
}

/** init_matter's fallback listing. */
interface FallbackListing {
  status: string;
  plan_digest: string;
  mode: "new" | "linked";
  linked_matter?: { id: number; title: string; url: string };
  room: number;
  files: Array<{ path: string; size_bytes: number; type: string; stored_name: string }>;
}

describe("init-matter against the fake DIKIGOROS API", () => {
  // Each step goes on from the one before it: the same helper, the same fake, the same folder.
  let scanId: string;
  let selection: SaveSelectionResult;
  let matterId: number;
  /** The document ids the first init_matter made, by relative path. */
  const docIds = new Map<string, number>();

  it("1. scan_project: reads the account and the matter list only, and finds four eligible files", async () => {
    const { result, requests } = await recording(() => handleScanProject({ root: folder }, helper));
    const summary = structured<Summary>(result);
    expect(requests.map(step)).toEqual(["GET /auth/current-user", "GET /api/matters"]);
    expect(summary).toMatchObject({
      status: "scanned",
      root: folder,
      mode: "new",
      room: { room: 50, per_matter: 50, held: 0, active_matters: { limit: 10, open: 0 } },
      counts: { files: 6, eligible: 4, ineligible: { too_large: 1, unsupported_type: 1 } },
    });
    expect(summary.linked_matter).toBeUndefined();
    // Tree order: a folder's own files, then its subfolders'. .DS_Store and node_modules have no row at all.
    expect(summary.eligible_files).toEqual([
      { path: NOTES, size_bytes: files[NOTES].byteLength, type: "text" },
      { path: OLD_CLAIM, size_bytes: files[OLD_CLAIM].byteLength, type: "pdf" },
      { path: CLAIM, size_bytes: files[CLAIM].byteLength, type: "pdf" },
      { path: DEFENCE, size_bytes: files[DEFENCE].byteLength, type: "docx" },
    ]);
    expect(summary.folders).toEqual([
      { path: "", files: 3, eligible: 1, ineligible: { too_large: 1, unsupported_type: 1 } },
      { path: "Old", files: 1, eligible: 1, ineligible: {} },
      { path: "Pleadings", files: 2, eligible: 2, ineligible: {} },
    ]);
    expect(JSON.stringify(summary)).not.toMatch(/DS_Store|node_modules/);
    // Nothing made, nothing stored, nothing written in the folder.
    expect(fake.state.matters.size).toBe(0);
    expect(fake.state.documents.size).toBe(0);
    expect(fake.state.blobs.size).toBe(0);
    await expect(stat(join(folder, LINK_DIR))).rejects.toThrow();
    scanId = summary.scan_id;
  });

  it("2. show_project_picker answers a small result; load_picker gives the widget the tree and the proposal", async () => {
    const preselect = [...FOUR, "photo.jpg", "big.pdf", "nowhere.pdf"];
    const shown = await recording(() => handleShowProjectPicker({ scan_id: scanId, matter: MATTER, preselect }, helper));
    const result = structured<ShowPickerResult>(shown.result);
    expect(result).toStrictEqual({ status: "picker_open", scan_id: scanId, mode: "new", room: 50, eligible: 4, preselected: 4 });
    // No path or name of any file: the tree is the app-only load_picker's.
    expect(JSON.stringify(shown.result)).not.toMatch(/\.pdf|\.docx|\.md|Pleadings|Old\//);
    // The sign-in and the account check only: no document route, nothing to the store.
    expect(shown.requests.map(step)).toEqual(["GET /auth/current-user"]);

    const loaded = await recording(() => handleLoadPicker({ scan_id: scanId }, helper));
    expect(loaded.requests).toEqual([]);
    const size = (path: string) => files[path].byteLength;
    expect(structured<PickerInput>(loaded.result)).toStrictEqual({
      scan_id: scanId,
      mode: "new",
      root: folder,
      room: 50,
      per_matter: 50,
      held: 0,
      matter: MATTER,
      // Claude's proposal as far as it is in the scan and eligible, in the order proposed.
      preselect: FOUR,
      folders: [
        { path: "", depth: 0 },
        { path: "Old", depth: 1 },
        { path: "Pleadings", depth: 1 },
      ],
      files: [
        { path: "big.pdf", name: "big.pdf", size_bytes: MAX_FILE_BYTES + 1, type: "pdf", eligible: false, reason: "too_large" },
        { path: NOTES, name: "notes.md", size_bytes: size(NOTES), type: "text", eligible: true },
        { path: "photo.jpg", name: "photo.jpg", size_bytes: size("photo.jpg"), type: null, eligible: false, reason: "unsupported_type" },
        { path: OLD_CLAIM, name: "Αγωγή.pdf", size_bytes: size(OLD_CLAIM), type: "pdf", eligible: true },
        { path: CLAIM, name: "Αγωγή.pdf", size_bytes: size(CLAIM), type: "pdf", eligible: true },
        { path: DEFENCE, name: "Υπεράσπιση.docx", size_bytes: size(DEFENCE), type: "docx", eligible: true },
      ],
      truncated: null,
    });
    expect(fake.state.blobs.size).toBe(0);
  });

  it("3. save_selection of the four: a selection_id and a digest, and no request at all", async () => {
    const { result, requests } = await recording(() =>
      handleSaveSelection({ scan_id: scanId, relative_paths: FOUR, matter: MATTER }, helper),
    );
    selection = structured<SaveSelectionResult>(result);
    expect(requests).toEqual([]);
    expect(selection.selection_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(selection.digest).toMatch(/^[0-9a-f]+$/);
    expect(selection).toMatchObject({ count: 4, total_bytes: FOUR.reduce((sum, path) => sum + files[path].byteLength, 0) });
    await expect(stat(join(folder, LINK_DIR))).rejects.toThrow();
  });

  it("4. init_matter: creates the matter, links the folder before the first upload, then uploads the four", async () => {
    const { result, requests } = await recording(() =>
      handleInitMatter({ selection_id: selection.selection_id, digest: selection.digest }, helper),
    );
    const report = structured<InitReport>(result);
    expect(report).toMatchObject({ status: "done", matter_created: true, left_over: 0 });
    matterId = report.matter_id;
    expect(fake.state.matters.size).toBe(1);
    expect(fake.state.matters.get(matterId)).toMatchObject({ title: PROJECT, caseReference: MATTER.case_reference, matterType: "civil" });
    // The selection's order decides the names: the later Αγωγή.pdf is stored as "Αγωγή (2).pdf".
    expect(report.results.map(({ relative_path, name, status }) => [relative_path, name, status])).toEqual([
      [CLAIM, "Αγωγή.pdf", "ready"],
      [DEFENCE, "Υπεράσπιση.docx", "ready"],
      [OLD_CLAIM, "Αγωγή (2).pdf", "ready"],
      [NOTES, "notes.md", "ready"],
    ]);
    for (const { relative_path, doc_id } of report.results) docIds.set(relative_path, doc_id as number);

    // The link file was on disk, naming the new matter and no file yet, when the first upload-token
    // request went out; the create was the only write before it.
    expect(atFirstUpload).toBeDefined();
    expect(atFirstUpload?.link).toStrictEqual({
      version: 1,
      baseUrl: fake.baseUrl,
      matterId,
      title: PROJECT,
      url: `${fake.baseUrl}/matters/${matterId}`,
      createdAt: expect.any(String),
      files: [],
    });
    expect(atFirstUpload?.before.slice(-2)).toEqual(["GET /auth/current-user", "POST /api/matters"]);
    expect(atFirstUpload?.before.some((line) => line.includes("/documents"))).toBe(false);

    const prefix = `matters/u${FAKE_USER.id}/m${matterId}/`;
    const documents = `/api/matters/${matterId}/documents`;
    const id = (path: string) => docIds.get(path);
    expect(requests.map(step)).toEqual([
      "GET /auth/current-user",
      "POST /api/matters",
      // Pleadings/Αγωγή.pdf: its text layer is enough.
      `POST ${documents}/upload for ${prefix}Αγωγή.pdf`,
      `PUT store ${prefix}Αγωγή.pdf`,
      `POST ${documents}`,
      `POST ${documents}/${id(CLAIM)}/ingest`,
      `POST ${documents}/${id(CLAIM)}/process`,
      `POST ${documents}/${id(CLAIM)}/process`,
      // Pleadings/Υπεράσπιση.docx
      `POST ${documents}/upload for ${prefix}Υπεράσπιση.docx`,
      `PUT store ${prefix}Υπεράσπιση.docx`,
      `POST ${documents}`,
      `POST ${documents}/${id(DEFENCE)}/ingest`,
      `POST ${documents}/${id(DEFENCE)}/process`,
      `POST ${documents}/${id(DEFENCE)}/process`,
      // Old/Αγωγή.pdf: the scan, and its page rendered for OCR.
      `POST ${documents}/upload for ${prefix}Αγωγή (2).pdf`,
      `PUT store ${prefix}Αγωγή (2).pdf`,
      `POST ${documents}/upload for ${prefix}pages/p1.jpg`,
      `PUT store ${prefix}pages/p1.jpg`,
      `POST ${documents}`,
      `POST ${documents}/${id(OLD_CLAIM)}/ingest`,
      `POST ${documents}/${id(OLD_CLAIM)}/process`,
      `POST ${documents}/${id(OLD_CLAIM)}/process`,
      // notes.md: its text, no blob and no ingest.
      `POST ${documents}/text`,
      `POST ${documents}/${id(NOTES)}/process`,
      `POST ${documents}/${id(NOTES)}/process`,
    ]);
    for (const { method, path, authorization, blob } of requests) {
      if (blob === undefined) expect(authorization, `${method} ${path}`).toBe(`Bearer ${TEST_TOKEN}`);
    }
    expect(bodiesOf(requests, "POST", "/api/matters")).toEqual([
      { title: PROJECT, matterType: "civil", caseReference: MATTER.case_reference },
    ]);

    // Each original registered under its stored name, at the URL the store gave it, with its own hash.
    const registered: Array<[string, string]> = [
      [CLAIM, "Αγωγή.pdf"],
      [DEFENCE, "Υπεράσπιση.docx"],
      [OLD_CLAIM, "Αγωγή (2).pdf"],
    ];
    expect(bodiesOf(requests, "POST", documents)).toEqual(
      registered.map(([path, name]) => ({
        filename: name,
        mimeType: name.endsWith(".pdf") ? "application/pdf" : DOCX_MIME,
        sizeBytes: files[path].byteLength,
        sha256: sha256(files[path]),
        blobUrl: storedUrl(requests, prefix + name),
        headBytesBase64: Buffer.from(files[path].subarray(0, 8)).toString("base64"),
      })),
    );
    const oldUrl = storedUrl(requests, `${prefix}Αγωγή (2).pdf`);
    expect(decodeURIComponent(new URL(oldUrl).pathname).startsWith(`/${prefix}Αγωγή (2).pdf-`)).toBe(true);
    expect(fake.state.blobs.get(`${prefix}Αγωγή (2).pdf`)).toBe(files[OLD_CLAIM].byteLength);

    // The manifests: the claim's text, the defence's, and the scan's page for OCR with its image.
    const manifest = (path: string) => bodiesOf(requests, "POST", `${documents}/${id(path)}/ingest`);
    const page = storedUrl(requests, `${prefix}pages/p1.jpg`);
    expect(page.startsWith(STORE + prefix)).toBe(true);
    expect(requests.find((request) => request.blob?.pathname === `${prefix}pages/p1.jpg`)?.blob?.sizeBytes).toBeGreaterThan(2048);
    expect(manifest(CLAIM)).toEqual([{ kind: "pdf", pages: [{ page: 1, text: CLAIM_TEXT, needsOcr: false }] }]);
    expect(manifest(DEFENCE)).toEqual([{ kind: "docx", fullText: DEFENCE_TEXT }]);
    expect(manifest(OLD_CLAIM)).toEqual([{ kind: "pdf", pages: [{ page: 1, text: "", needsOcr: true, imageBlobKey: page }] }]);
    expect(bodiesOf(requests, "POST", `${documents}/text`)).toEqual([{ filename: "notes.md", text: NOTES_TEXT }]);

    // The link file now: the four, ready, each with the document the fake holds under its stored name.
    const link = await linkOnDisk();
    expect(link).toMatchObject({ version: 1, baseUrl: fake.baseUrl, matterId, title: PROJECT });
    expect(link.files).toStrictEqual(
      await Promise.all(
        FOUR.map(async (path) => {
          const { size, mtimeMs } = await stat(join(folder, path));
          const storedName = report.results.find((row) => row.relative_path === path)?.name;
          const hash = path === NOTES ? null : sha256(files[path]);
          return { relativePath: path, storedName, sizeBytes: size, mtimeMs, sha256: hash, docId: id(path), status: "ready" };
        }),
      ),
    );
    for (const entry of link.files) {
      expect(entry.sha256 === null || /^[0-9a-f]{64}$/.test(entry.sha256), entry.relativePath).toBe(true);
      const document = fake.state.documents.get(entry.docId as number);
      expect(document, entry.relativePath).toMatchObject({ matterId, filename: entry.storedName, ingestStatus: "ready" });
    }
    expect(JSON.stringify(link)).not.toMatch(/token|secret|authorization/i);
  });

  it("5. the re-run: linked, the four already uploaded, and a new file added through the text fallback", async () => {
    const scanned = await recording(() => handleScanProject({ root: folder }, helper));
    const summary = structured<Summary>(scanned.result);
    expect(scanned.requests.map(step)).toEqual(["GET /auth/current-user", "GET /api/matters", `GET /api/matters/${matterId}`]);
    expect(summary).toMatchObject({
      mode: "linked",
      linked_matter: { id: matterId, title: PROJECT, url: `${fake.baseUrl}/matters/${matterId}` },
      room: { room: 46, per_matter: 50, held: 4 },
      counts: { files: 6, eligible: 0, ineligible: { already_uploaded: 4, too_large: 1, unsupported_type: 1 } },
      eligible_files: [],
    });

    files[AFFIDAVIT] = textPdf(AFFIDAVIT_LINES);
    await writeFile(join(folder, AFFIDAVIT), files[AFFIDAVIT]);
    const before = fake.state.documents.size;

    // Without confirm: the one new file listed, and only reads sent.
    const listed = await recording(() => handleInitMatter({ root: folder, relative_paths: [AFFIDAVIT] }, helper));
    const listing = structured<FallbackListing>(listed.result);
    expect(listed.requests.map(step)).toEqual(["GET /auth/current-user", "GET /api/matters", `GET /api/matters/${matterId}`]);
    expect(listing).toMatchObject({
      status: "confirmation_required",
      mode: "linked",
      linked_matter: { id: matterId, title: PROJECT },
      room: 46,
    });
    expect(listing.files).toStrictEqual([
      { path: AFFIDAVIT, size_bytes: files[AFFIDAVIT].byteLength, type: "pdf", stored_name: "Ένορκη δήλωση.pdf" },
    ]);
    expect(fake.state.documents.size).toBe(before);
    expect((await linkOnDisk()).files).toHaveLength(4);

    // With confirm and the listing's digest: into the same matter, no second matter.
    const confirmed = await recording(() =>
      handleInitMatter({ root: folder, relative_paths: [AFFIDAVIT], confirm: true, plan_digest: listing.plan_digest }, helper),
    );
    const report = structured<InitReport>(confirmed.result);
    expect(report).toMatchObject({ status: "done", matter_created: false, matter_id: matterId, left_over: 0 });
    expect(report.results.map(({ relative_path, name, status }) => [relative_path, name, status])).toEqual([
      [AFFIDAVIT, "Ένορκη δήλωση.pdf", "ready"],
    ]);
    const affidavitId = report.results[0].doc_id;
    const prefix = `matters/u${FAKE_USER.id}/m${matterId}/`;
    const documents = `/api/matters/${matterId}/documents`;
    expect(confirmed.requests.map(step)).toEqual([
      "GET /auth/current-user",
      "GET /api/matters",
      `GET /api/matters/${matterId}`,
      // The link file read again just before the uploads, its matter checked.
      `GET /api/matters/${matterId}`,
      `POST ${documents}/upload for ${prefix}Ένορκη δήλωση.pdf`,
      `PUT store ${prefix}Ένορκη δήλωση.pdf`,
      `POST ${documents}`,
      `POST ${documents}/${affidavitId}/ingest`,
      `POST ${documents}/${affidavitId}/process`,
      `POST ${documents}/${affidavitId}/process`,
    ]);
    expect(bodiesOf(confirmed.requests, `POST`, `${documents}/${affidavitId}/ingest`)).toEqual([
      { kind: "pdf", pages: [{ page: 1, text: AFFIDAVIT_TEXT, needsOcr: false }] },
    ]);
    expect(fake.state.matters.size).toBe(1);

    const link = await linkOnDisk();
    expect(link.matterId).toBe(matterId);
    expect(link.files.map(({ relativePath, status }) => [relativePath, status])).toEqual([
      ...FOUR.map((path) => [path, "ready"]),
      [AFFIDAVIT, "ready"],
    ]);
    expect(link.files[4]).toMatchObject({ storedName: "Ένορκη δήλωση.pdf", sha256: sha256(files[AFFIDAVIT]), docId: affidavitId });
  });

  it("the confirmed picker selection sent again: the four come back as duplicates, and no matter is made", async () => {
    const { result, requests } = await recording(() =>
      handleInitMatter({ selection_id: selection.selection_id, digest: selection.digest }, helper),
    );
    const report = structured<InitReport>(result);
    expect(report).toMatchObject({ status: "done", matter_created: false, matter_id: matterId });
    expect(report.results.map(({ relative_path, name, status, doc_id }) => [relative_path, name, status, doc_id])).toEqual([
      [CLAIM, "Αγωγή.pdf", "duplicate", docIds.get(CLAIM)],
      [DEFENCE, "Υπεράσπιση.docx", "duplicate", docIds.get(DEFENCE)],
      [OLD_CLAIM, "Αγωγή (2).pdf", "duplicate", docIds.get(OLD_CLAIM)],
      [NOTES, "notes.md", "duplicate", docIds.get(NOTES)],
    ]);
    expect(requests.map(step)).not.toContain("POST /api/matters");
    expect(requests.map(step).slice(0, 2)).toEqual(["GET /auth/current-user", `GET /api/matters/${matterId}`]);
    // The same stored names went to the documents routes, each refused as the twin it is.
    const documents = `/api/matters/${matterId}/documents`;
    expect(
      requests
        .filter(({ method, path }) => method === "POST" && (path === documents || path === `${documents}/text`))
        .map(({ body, status }) => [(body as { filename: string }).filename, status]),
    ).toEqual([
      ["Αγωγή.pdf", 409],
      ["Υπεράσπιση.docx", 409],
      ["Αγωγή (2).pdf", 409],
      ["notes.md", 409],
    ]);
    expect(fake.state.matters.size).toBe(1);
    expect(fake.state.documents.size).toBe(5);

    const link = await linkOnDisk();
    expect(link.files.map(({ relativePath, status, docId }) => [relativePath, status, docId])).toEqual([
      ...FOUR.map((path) => [path, "duplicate", docIds.get(path)]),
      [AFFIDAVIT, "ready", link.files[4].docId],
    ]);
  });
});
