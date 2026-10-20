// The whole upload flow as the dikigoros-upload server runs it, against an in-memory DIKIGOROS API
// and private blob store over http (../support/fake-api): upload_to_matter's listing and confirmed
// calls through the real upload plan, REST client, blob upload, PDF extraction (pdf.js with the dev
// @napi-rs/canvas and pdf.js's own assets), DOCX extraction and document pipeline. Only the sign-in
// is a stub: a session that always holds the token the fake accepts. What is checked is what
// reached the fake: the requests the helper made, their bodies, and the blobs it put in the store.

import type { CallToolResult } from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadBlob } from "../../src/api/blob-upload";
import { DikigorosApi } from "../../src/api/client";
import { DEVICE_SCOPES, type HelperConfig } from "../../src/config";
import { extractDocx } from "../../src/extract/docx";
import { extractPdf, type PdfAssets } from "../../src/extract/pdf";
import { resolveUploadPlan } from "../../src/files/resolve";
import type { CanvasModule } from "../../src/native/load";
import { uploadDocument, type UploadDeps } from "../../src/pipeline/upload-document";
import { handleCreateMatter, handleUploadToMatter, type SessionLike, type ToolDeps } from "../../src/server/tools";
import { makeDocx } from "../support/docx-fixture";
import { FAKE_USER, type FakeApi, type RecordedRequest, startFakeApi, TEST_TOKEN } from "../support/fake-api";
import { imagePdf, textPdf } from "../support/pdf-fixtures";

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

/** The claim's file name: Greek letters, spaces, a dot and parentheses, verbatim all the way to the store. */
const CLAIM = "Αγωγή αρ. 5 (αντίγραφο).pdf";
const CLAIM_LINES = ["The first page of the claim carries a text layer", "long enough to need no OCR."];
/** The claim's page as pdf.js reads it: the two lines joined by a space. */
const CLAIM_TEXT = "The first page of the claim carries a text layer long enough to need no OCR.";
const BRIEF_PARAGRAPHS = ["ΥΠΟΜΝΗΜΑ", "Το υπόμνημα της εναγομένης, σε δύο παραγράφους."];
/** brief.docx as mammoth reads it: each paragraph followed by a blank line. */
const BRIEF_TEXT = "ΥΠΟΜΝΗΜΑ\n\nΤο υπόμνημα της εναγομένης, σε δύο παραγράφους.\n\n";
/** notes.txt as written: UTF-8 Greek with a byte-order mark, CRLF line ends and a trailing blank line. */
const NOTES = "\uFEFFΣημειώσεις από τη συνάντηση.\r\nΕπόμενη δικάσιμος: 12 Νοεμβρίου.\r\n\r\n";
/** notes.txt as the text route must receive it: no BOM, LF line ends, the ends trimmed. */
const NOTES_TEXT = "Σημειώσεις από τη συνάντηση.\nΕπόμενη δικάσιμος: 12 Νοεμβρίου.";

/** What a listing says of the files, as structuredContent carries it. */
interface Listing {
  status: string;
  plan_digest: string;
  files: Array<{ name: string; size_bytes: number; type: string }>;
  skipped: { shown: Array<{ name: string; reason: string }>; counts: Record<string, number> };
}

/** What a confirmed call reports of each file. */
interface Report {
  status: string;
  results: Array<{ name: string; status: string; doc_id?: number }>;
}

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
/** The one path both calls name: a folder holding the seven files below. */
let folder: string;
const files: Record<string, Uint8Array> = {};

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "dikigoros-upload-flow-"));
  folder = join(tmp, "files");
  await mkdir(folder);
  files[CLAIM] = textPdf(CLAIM_LINES);
  files["scan.pdf"] = imagePdf({ ink: true });
  // A CCITT G4 scan, which pdf.js decodes with its JBIG2 wasm module.
  files["ccitt-g4.pdf"] = await readFile(join(ROOT, "test", "fixtures", "ccitt-g4.pdf"));
  files["brief.docx"] = await makeDocx(BRIEF_PARAGRAPHS);
  files["notes.txt"] = new TextEncoder().encode(NOTES);
  files[".hidden.pdf"] = textPdf(["A dotfile in the folder, which the listing leaves out."]);
  files["photo.jpg"] = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(folder, name), bytes);
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

let fake: FakeApi;
let helper: ToolDeps;
let matterId: number;

beforeEach(async () => {
  fake = await startFakeApi({ ocrBatches: 2 });
  // Read by the blob SDK on every upload: the fake's store, and every store failure final at once.
  vi.stubEnv("VERCEL_BLOB_API_URL", `${fake.baseUrl}/blob-store`);
  vi.stubEnv("VERCEL_BLOB_RETRIES", "0");
  helper = helperFor(fake.baseUrl);
  const created = structured<{ matter: { id: number } }>(await handleCreateMatter({ title: "Upload flow" }, helper));
  matterId = created.matter.id;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fake.close();
});

/**
 * The tool handlers' dependencies as src/server/main.ts wires them, against `baseUrl`: the real
 * modules throughout, but for the stub session, the native runtime of the dev dependencies and a
 * sleep that does not wait between polls. The configuration is built here, as loadConfig refuses
 * any origin but the two the helper may talk to.
 */
function helperFor(baseUrl: string): ToolDeps {
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
    fetchImpl: fetch,
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
  };
}

/** The result's structuredContent; fails the test, with the result's text, on an error result. */
function structured<T>(result: CallToolResult): T {
  const [first] = result.content;
  expect(result.isError, first?.type === "text" ? first.text : undefined).toBeUndefined();
  return result.structuredContent as T;
}

/** The first call of upload_to_matter: the folder's listing. */
async function list(): Promise<Listing> {
  return structured<Listing>(await handleUploadToMatter({ matter_id: matterId, paths: [folder] }, helper));
}

/** The listing, then the call that confirms it: what the helper reports for each file. */
async function upload(): Promise<Report> {
  const { plan_digest } = await list();
  const args = { matter_id: matterId, paths: [folder], confirm: true, plan_digest };
  return structured<Report>(await handleUploadToMatter(args, helper));
}

/** The bodies of the requests to `method path` among `requests`, in the order they were sent. */
function bodiesOf(requests: RecordedRequest[], method: string, path: string): unknown[] {
  return requests.filter((request) => request.method === method && request.path === path).map(({ body }) => body);
}

/** The URLs the store answered for the PUTs of `pathname` among `requests`, in the order they were sent. */
function storedUrls(requests: RecordedRequest[], pathname: string): string[] {
  return requests.filter((request) => request.blob?.pathname === pathname).map(({ answer }) => (answer as { url: string }).url);
}

/** The URL the store answered for its one PUT of `pathname` among `requests`. */
function storedUrl(requests: RecordedRequest[], pathname: string): string {
  const urls = storedUrls(requests, pathname);
  expect(urls, pathname).toHaveLength(1);
  return urls[0];
}

/** Every request to the API carries the session's bearer; the store's PUTs carry a client token instead. */
function expectTheBearerOnEveryApiRequest(): void {
  const apiRequests = fake.requests.filter((request) => request.blob === undefined);
  expect(apiRequests.length).toBeGreaterThan(0);
  for (const { method, path, authorization } of apiRequests) {
    expect(authorization, `${method} ${path}`).toBe(`Bearer ${TEST_TOKEN}`);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("upload_to_matter against the fake DIKIGOROS API", () => {
  it("lists the five files to upload and the photo to skip, leaves the dotfile out and sends nothing about them", async () => {
    const sent = fake.requests.length;
    const listing = await list();
    expect(listing.status).toBe("confirmation_required");
    // Sorted by name, the Greek one last; .hidden.pdf has no row at all: a folder's listing leaves its dotfiles out.
    const kinds: Record<string, string> = {
      "brief.docx": "docx",
      "ccitt-g4.pdf": "pdf",
      "notes.txt": "text",
      "scan.pdf": "pdf",
      [CLAIM]: "pdf",
    };
    expect(listing.files).toEqual(
      Object.entries(kinds).map(([name, type]) => ({ name, size_bytes: files[name].byteLength, type })),
    );
    expect(listing.skipped).toEqual({
      shown: [{ name: "photo.jpg", reason: "unsupported_type" }],
      counts: { unsupported_type: 1 },
    });
    // The account and the matter only: nothing about the files, and nothing to the store.
    expect(fake.requests.slice(sent).map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /auth/current-user",
      `GET /api/matters/${matterId}`,
    ]);
    expect(fake.state.blobs.size).toBe(0);
    expect(fake.state.documents.size).toBe(0);
  });

  it("on confirm uploads the five files the way the web uploader does, each to ready", async () => {
    const sent = fake.requests.length;
    const report = await upload();
    const requests = fake.requests.slice(sent);
    expect(report.status).toBe("done");
    expect(report.results.map(({ name, status }) => [name, status])).toEqual([
      ["brief.docx", "ready"],
      ["ccitt-g4.pdf", "ready"],
      ["notes.txt", "ready"],
      ["scan.pdf", "ready"],
      [CLAIM, "ready"],
    ]);
    expectTheBearerOnEveryApiRequest();

    const prefix = `matters/u${FAKE_USER.id}/m${matterId}/`;
    const documents = `/api/matters/${matterId}/documents`;

    // A client token for each blob, asked for with the event @vercel/blob/client sends its handleUploadUrl.
    expect(bodiesOf(requests, "POST", `${documents}/upload`)).toEqual(
      ["brief.docx", "ccitt-g4.pdf", "pages/p1.jpg", "scan.pdf", "pages/p1.jpg", CLAIM].map((name) => ({
        type: "blob.generate-client-token",
        payload: { pathname: prefix + name, clientPayload: null, multipart: false },
      })),
    );

    // The one page of each scan, rendered for OCR: a JPEG in the store, named in the manifest under the
    // matter's prefix. Both are page 1 of their document, and the store tells them apart by its suffix.
    const pagePuts = requests.filter((request) => request.blob?.pathname === `${prefix}pages/p1.jpg`);
    expect(pagePuts).toHaveLength(2);
    for (const put of pagePuts) expect(put.blob?.sizeBytes).toBeGreaterThan(2048);
    const [ccittPage, scanPage] = storedUrls(requests, `${prefix}pages/p1.jpg`);
    for (const url of [ccittPage, scanPage]) expect(url.startsWith(STORE + prefix)).toBe(true);
    expect(ccittPage).not.toBe(scanPage);

    // Each original registered at the URL the store gave it, with its own hash, size and first bytes.
    const created = bodiesOf(requests, "POST", documents);
    expect(created).toEqual(
      ["brief.docx", "ccitt-g4.pdf", "scan.pdf", CLAIM].map((name) => ({
        filename: name,
        mimeType: name.endsWith(".pdf") ? "application/pdf" : DOCX_MIME,
        sizeBytes: files[name].byteLength,
        sha256: sha256(files[name]),
        blobUrl: storedUrl(requests, prefix + name),
        headBytesBase64: Buffer.from(files[name].subarray(0, 8)).toString("base64"),
      })),
    );
    for (const body of created) expect((body as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/);
    // The Greek name, its spaces and parentheses went to the store as they are, and came back in the URL
    // registered for it: decoded, its path is the matter's prefix and the name, then the store's suffix.
    const claimUrl = storedUrl(requests, prefix + CLAIM);
    expect(decodeURIComponent(new URL(claimUrl).pathname).startsWith(`/${prefix}${CLAIM}-`)).toBe(true);

    // The manifests, each ingested into the document it was extracted for.
    const docIds = new Map(report.results.map(({ name, doc_id }) => [name, doc_id]));
    const manifest = (name: string) => bodiesOf(requests, "POST", `${documents}/${docIds.get(name)}/ingest`);
    const scanned = (imageBlobKey: string) => [{ kind: "pdf", pages: [{ page: 1, text: "", needsOcr: true, imageBlobKey }] }];
    expect(manifest("ccitt-g4.pdf")).toEqual(scanned(ccittPage));
    expect(manifest("scan.pdf")).toEqual(scanned(scanPage));
    expect(manifest(CLAIM)).toEqual([{ kind: "pdf", pages: [{ page: 1, text: CLAIM_TEXT, needsOcr: false }] }]);
    expect(manifest("brief.docx")).toEqual([{ kind: "docx", fullText: BRIEF_TEXT }]);

    // notes.txt goes as its normalised text, with no blob and no ingest.
    expect(bodiesOf(requests, "POST", `${documents}/text`)).toEqual([{ filename: "notes.txt", text: NOTES_TEXT }]);
  });

  it("a second confirmed call reports the five files as duplicates of the documents the first one made", async () => {
    const first = await upload();
    const second = await upload();
    expect(second.results.map(({ name, status }) => [name, status])).toEqual([
      ["brief.docx", "duplicate"],
      ["ccitt-g4.pdf", "duplicate"],
      ["notes.txt", "duplicate"],
      ["scan.pdf", "duplicate"],
      [CLAIM, "duplicate"],
    ]);
    expect(second.results.map(({ doc_id }) => doc_id)).toEqual(first.results.map(({ doc_id }) => doc_id));
    expectTheBearerOnEveryApiRequest();
  });
});
