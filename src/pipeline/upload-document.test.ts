// uploadDocument against recording fakes: an API whose every method is a vi.fn() with canned
// answers, a blob store answering https://teststore.private.blob.vercel-storage.com/<pathname>-x,
// extractors and a file reader with fixed answers, a sleep that resolves at once and moves the clock
// the pipeline reads. `calls` lists every step in the order it was taken.

import { describe, expect, it, vi } from "vitest";
import type { BlobUploadArgs } from "../api/blob-upload";
import type {
  DikigorosApi,
  IngestStatus,
  MatterDocumentDetail,
  MatterDocumentRecord,
  ProcessResult,
} from "../api/client";
import { ApiError } from "../api/errors";
import type { ExtractedPdf } from "../extract/pdf";
import type { PlanEntry } from "../files/resolve";
import { type DocumentOutcome, uploadDocument, type UploadContext, type UploadDeps } from "./upload-document";

const CTX: UploadContext = { baseUrl: "https://dikigoros.ai", userId: 42, matterId: 7 };
const STORE = "https://teststore.private.blob.vercel-storage.com/";
const STILL_PROCESSING = "still processing; the matter page resumes it, or call again later";

/** claim.pdf as the reader returns it: 58 bytes, the first 8 of them "%PDF-1.7". */
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n% claim.pdf, as the fake reader returns it\n%%EOF\n");
const PDF_SHA256 = "efa6110daca6ee9f16d4fd1abf39c79171aa1cbede47a8dfc469ce78d804db58";
/** The start of a zip's first local file header (PK\3\4, version 20, flags 6): 14 bytes. */
const DOCX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00, 0x00, 0x00, 0x21, 0x00]);
const DOCX_SHA256 = "adef4eeb365871c7d8ae7b7cbeb087585a80d586946c610ed824a42d88e65a79";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX_TEXT = "ΥΠΕΡΑΣΠΙΣΗ\n\nΟ εναγόμενος αρνείται κάθε ισχυρισμό της αγωγής.\n\n";
/** «Αγωγή», CRLF, «αρ. 112 », CRLF in windows-1253: 0xC1 is never UTF-8. */
const GREEK_1253 = new Uint8Array([
  0xc1, 0xe3, 0xf9, 0xe3, 0xde, 0x0d, 0x0a, 0xe1, 0xf1, 0x2e, 0x20, 0x31, 0x31, 0x32, 0x20, 0x0d, 0x0a,
]);

const JPEG_P1 = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01]);
const JPEG_P2 = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x02]);

/** A page with a text layer, then a scanned page rendered for OCR. */
const TWO_PAGES: ExtractedPdf = {
  pages: [
    { page: 1, text: "ΑΓΩΓΗ του Γεωργίου κατά Πέτρου, ενώπιον του Επαρχιακού Δικαστηρίου Λευκωσίας.", needsOcr: false },
    { page: 2, text: "", needsOcr: true },
  ],
  images: new Map([[2, JPEG_P2]]),
};

/** Two scanned pages, both rendered for OCR. */
const SCAN: ExtractedPdf = {
  pages: [
    { page: 1, text: "", needsOcr: true },
    { page: 2, text: "Σφραγίδα", needsOcr: true },
  ],
  images: new Map([
    [1, JPEG_P1],
    [2, JPEG_P2],
  ]),
};

/** POST …/documents: the new row, pending. */
const CREATED: MatterDocumentRecord = {
  id: 31,
  matterId: 7,
  filename: "claim.pdf",
  mimeType: "application/pdf",
  sizeBytes: 58,
  role: null,
  side: null,
  roleConfirmed: false,
  guide: null,
  origin: "upload",
  ingestStatus: "pending",
  ingestError: null,
  ocrApplied: false,
  pageCount: 0,
  createdAt: "2026-10-19T10:00:00.000Z",
};

/** POST …/documents/text: the row already processing, with its one page. */
const CREATED_TEXT: MatterDocumentRecord = {
  ...CREATED,
  id: 32,
  filename: "σημείωμα.txt",
  mimeType: "text/plain",
  sizeBytes: 17,
  origin: "text",
  ingestStatus: "processing",
  pageCount: 1,
};

/** PATCH …/documents/31. */
const PATCHED: MatterDocumentRecord = { ...CREATED, role: "exhibit", side: "ours", roleConfirmed: true };

const processing = (ocrRemaining: number): ProcessResult => ({ status: "processing", ocrRemaining });

/** POST …/process once the document is ready: the finished row with `pageCount` pages. */
const ready = (pageCount: number): ProcessResult => ({
  status: "ready",
  ocrRemaining: 0,
  suggested: true,
  document: {
    id: 31,
    filename: "claim.pdf",
    role: "statement_of_claim",
    side: "ours",
    roleConfirmed: false,
    ingestStatus: "ready",
    pageCount,
    ocrApplied: true,
    extractedText: "",
  },
});

/** GET …/documents/12: the same file, already in the matter. */
const twin = (ingestStatus: IngestStatus): MatterDocumentDetail => ({
  id: 12,
  filename: "claim.pdf",
  mimeType: "application/pdf",
  sizeBytes: 58,
  role: "statement_of_claim",
  side: "ours",
  roleConfirmed: true,
  guide: null,
  origin: "upload",
  ingestStatus,
  ingestError: null,
  pageCount: 2,
  ocrApplied: false,
  createdAt: "2026-10-18T09:00:00.000Z",
  updatedAt: "2026-10-18T09:05:00.000Z",
  pages: [
    { page: 1, needsOcr: false, ocrDone: false, confidence: null },
    { page: 2, needsOcr: true, ocrDone: false, confidence: null },
  ],
  extractedText: null,
});

const duplicateOf = (documentId: number) => new ApiError(409, "duplicate_document", { documentId });
const utf8 = (text: string) => new TextEncoder().encode(text);

/**
 * A planned upload named through a link to the matter's folder; the plan saw 48,213 bytes, and the
 * file has changed since.
 */
function planned(name: string, kind: PlanEntry["kind"]): PlanEntry {
  return {
    path: `/Users/eleni/Desktop/Georgiou/${name}`,
    realPath: `/Users/eleni/Matters/Georgiou/${name}`,
    name,
    sizeBytes: 48_213,
    kind,
    decision: "upload",
  };
}

/** Answers in order, an Error thrown; once a queue is empty, the fake's usual answer. */
type Queue<T> = Array<T | Error>;

interface Answers {
  readFile?: Queue<Uint8Array>;
  uploadBlob?: Queue<{ url: string }>;
  extractPdf?: Queue<ExtractedPdf>;
  extractDocx?: Queue<{ fullText: string }>;
  createDocument?: Queue<MatterDocumentRecord>;
  createTextDocument?: Queue<MatterDocumentRecord>;
  patchDocument?: Queue<MatterDocumentRecord>;
  getDocument?: Queue<MatterDocumentDetail>;
  ingest?: Queue<{ ocrPages: number }>;
  process?: Queue<ProcessResult>;
}

function next<T>(queue: Queue<T> | undefined, usual: T): T {
  const answer = queue?.shift();
  if (answer instanceof Error) throw answer;
  return answer ?? usual;
}

function fakes(answers: Answers = {}) {
  const calls: string[] = [];
  const fake = <T>(label: string, queue: Queue<T> | undefined, usual: T) =>
    vi.fn<(...args: unknown[]) => Promise<T>>(async () => {
      calls.push(label);
      return next(queue, usual);
    });
  const api = {
    createDocument: fake("createDocument", answers.createDocument, CREATED),
    createTextDocument: fake("createTextDocument", answers.createTextDocument, CREATED_TEXT),
    patchDocument: fake("patchDocument", answers.patchDocument, PATCHED),
    getDocument: fake("getDocument", answers.getDocument, twin("ready")),
    ingest: fake("ingest", answers.ingest, { ocrPages: 0 }),
    process: fake("process", answers.process, ready(2)),
  };
  const uploadBlob = vi.fn(async ({ pathname }: BlobUploadArgs) => {
    calls.push(`uploadBlob(${pathname})`);
    return next(answers.uploadBlob, { url: `${STORE}${pathname}-x` });
  });
  const readFile = fake("readFile", answers.readFile, PDF_BYTES);
  const extractPdf = fake("extractPdf", answers.extractPdf, TWO_PAGES);
  const extractDocx = fake("extractDocx", answers.extractDocx, { fullText: DOCX_TEXT });
  let clock = 1_760_870_400_000;
  const sleep = vi.fn(async (ms: number) => {
    calls.push(`sleep(${ms})`);
    clock += ms;
  });
  const log = vi.fn<(line: string) => void>();
  const deps: UploadDeps = {
    api: api as unknown as DikigorosApi,
    uploadBlob,
    extractPdf,
    extractDocx,
    readFile,
    sleep,
    now: () => clock,
    log,
  };
  return { deps, api, uploadBlob, readFile, extractPdf, extractDocx, sleep, log, calls };
}

describe("uploadDocument: a PDF or a DOCX", () => {
  it("uploads a PDF the web uploader's way, then polls it to ready", async () => {
    const f = fakes({ ingest: [{ ocrPages: 1 }], process: [processing(1), ready(2)] });
    const outcome = await uploadDocument(planned("claim.pdf", "pdf"), CTX, f.deps);

    expect(f.calls).toEqual([
      "readFile",
      "uploadBlob(matters/u42/m7/claim.pdf)",
      "extractPdf",
      "uploadBlob(matters/u42/m7/pages/p2.jpg)",
      "createDocument",
      "ingest",
      "process",
      "sleep(1500)",
      "process",
    ]);
    // The path the plan checked, its links resolved.
    expect(f.readFile.mock.calls).toEqual([["/Users/eleni/Matters/Georgiou/claim.pdf"]]);
    expect(f.uploadBlob.mock.calls).toStrictEqual([
      [{ api: f.api, matterId: 7, pathname: "matters/u42/m7/claim.pdf", bytes: PDF_BYTES, contentType: "application/pdf" }],
      [{ api: f.api, matterId: 7, pathname: "matters/u42/m7/pages/p2.jpg", bytes: JPEG_P2, contentType: "image/jpeg" }],
    ]);
    expect(f.extractPdf.mock.calls[0][0]).toBe(PDF_BYTES);
    // The size of the bytes uploaded, their hash, and the first 8 of them for the server's sniff.
    expect(f.api.createDocument.mock.calls).toStrictEqual([
      [
        7,
        {
          filename: "claim.pdf",
          mimeType: "application/pdf",
          sizeBytes: 58,
          sha256: PDF_SHA256,
          blobUrl: `${STORE}matters/u42/m7/claim.pdf-x`,
          headBytesBase64: "JVBERi0xLjc=",
        },
      ],
    ]);
    expect(f.api.ingest.mock.calls).toStrictEqual([
      [
        7,
        31,
        {
          kind: "pdf",
          pages: [
            { page: 1, text: TWO_PAGES.pages[0].text, needsOcr: false },
            { page: 2, text: "", needsOcr: true, imageBlobKey: `${STORE}matters/u42/m7/pages/p2.jpg-x` },
          ],
        },
      ],
    ]);
    expect(f.api.process.mock.calls).toEqual([
      [7, 31],
      [7, 31],
    ]);
    expect(f.log.mock.calls).toEqual([["claim.pdf: OCR, 1 page(s) remaining"]]);
    expect(outcome).toStrictEqual({ name: "claim.pdf", status: "ready", documentId: 31, pageCount: 2, ocrPages: 1 });
  });

  it("registers a DOCX with its whole text as the manifest", async () => {
    const f = fakes({ readFile: [DOCX_BYTES], process: [ready(1)] });
    const outcome = await uploadDocument(planned("υπεράσπιση.docx", "docx"), CTX, f.deps);

    expect(f.calls).toEqual([
      "readFile",
      "uploadBlob(matters/u42/m7/υπεράσπιση.docx)",
      "extractDocx",
      "createDocument",
      "ingest",
      "process",
    ]);
    expect(f.uploadBlob.mock.calls).toStrictEqual([
      [{ api: f.api, matterId: 7, pathname: "matters/u42/m7/υπεράσπιση.docx", bytes: DOCX_BYTES, contentType: DOCX_MIME }],
    ]);
    expect(f.extractDocx.mock.calls[0][0]).toBe(DOCX_BYTES);
    expect(f.api.createDocument.mock.calls).toStrictEqual([
      [
        7,
        {
          filename: "υπεράσπιση.docx",
          mimeType: DOCX_MIME,
          sizeBytes: 14,
          sha256: DOCX_SHA256,
          blobUrl: `${STORE}matters/u42/m7/υπεράσπιση.docx-x`,
          headBytesBase64: "UEsDBBQABgA=",
        },
      ],
    ]);
    expect(f.api.ingest.mock.calls).toStrictEqual([[7, 31, { kind: "docx", fullText: DOCX_TEXT }]]);
    expect(outcome).toStrictEqual({
      name: "υπεράσπιση.docx",
      status: "ready",
      documentId: 31,
      pageCount: 1,
      ocrPages: 0,
    });
  });

  it("stops before registering a scan with no text layer and no page that rendered ink", async () => {
    const blank: ExtractedPdf = {
      pages: [
        { page: 1, text: "", needsOcr: true },
        { page: 2, text: "", needsOcr: true },
      ],
      images: new Map(),
    };
    const f = fakes({ extractPdf: [blank] });
    const outcome = await uploadDocument(planned("scan.pdf", "pdf"), CTX, f.deps);

    // The original is in the store already, as in the browser.
    expect(f.calls).toEqual(["readFile", "uploadBlob(matters/u42/m7/scan.pdf)", "extractPdf"]);
    expect(outcome).toStrictEqual({
      name: "scan.pdf",
      status: "failed",
      code: "no_text_extracted",
      message: "No readable text found — the pages appear to be blank",
    });
  });

  it("takes the size and the head of the bytes before an extractor can take over their buffer", async () => {
    const f = fakes({ readFile: [PDF_BYTES.slice()] });
    f.extractPdf.mockImplementationOnce(async (bytes) => {
      const { buffer } = bytes as Uint8Array;
      structuredClone(buffer, { transfer: [buffer as ArrayBuffer] }); // as pdf.js does with the buffer it gets
      return TWO_PAGES;
    });
    const outcome = await uploadDocument(planned("claim.pdf", "pdf"), CTX, f.deps);
    expect(f.api.createDocument.mock.calls).toMatchObject([[7, { sizeBytes: 58, headBytesBase64: "JVBERi0xLjc=" }]]);
    expect(outcome.status).toBe("ready");
  });

  it("registers a PDF whose every page has a text layer, with no page images", async () => {
    const typed: ExtractedPdf = {
      pages: [
        { page: 1, text: "ΑΓΩΓΗ του Γεωργίου κατά Πέτρου.", needsOcr: false },
        { page: 2, text: "Ο ενάγων ζητά την απόδοση του μισθίου.", needsOcr: false },
      ],
      images: new Map(),
    };
    const f = fakes({ extractPdf: [typed] });
    const outcome = await uploadDocument(planned("claim.pdf", "pdf"), CTX, f.deps);

    expect(f.calls).toEqual([
      "readFile",
      "uploadBlob(matters/u42/m7/claim.pdf)",
      "extractPdf",
      "createDocument",
      "ingest",
      "process",
    ]);
    expect(f.api.ingest.mock.calls[0][2]).toStrictEqual({
      kind: "pdf",
      pages: [
        { page: 1, text: "ΑΓΩΓΗ του Γεωργίου κατά Πέτρου.", needsOcr: false },
        { page: 2, text: "Ο ενάγων ζητά την απόδοση του μισθίου.", needsOcr: false },
      ],
    });
    expect(outcome).toStrictEqual({ name: "claim.pdf", status: "ready", documentId: 31, pageCount: 2, ocrPages: 0 });
  });

  it("keeps a scanned page that rendered blank as needing OCR, beside one that rendered ink", async () => {
    const mixed: ExtractedPdf = {
      pages: [
        { page: 1, text: "", needsOcr: true },
        { page: 2, text: "", needsOcr: true },
      ],
      images: new Map([[1, JPEG_P1]]),
    };
    const f = fakes({ extractPdf: [mixed], ingest: [{ ocrPages: 2 }] });
    const outcome = await uploadDocument(planned("scan.pdf", "pdf"), CTX, f.deps);

    expect(f.calls).toEqual([
      "readFile",
      "uploadBlob(matters/u42/m7/scan.pdf)",
      "extractPdf",
      "uploadBlob(matters/u42/m7/pages/p1.jpg)",
      "createDocument",
      "ingest",
      "process",
    ]);
    expect(f.api.ingest.mock.calls[0][2]).toStrictEqual({
      kind: "pdf",
      pages: [
        { page: 1, text: "", needsOcr: true, imageBlobKey: `${STORE}matters/u42/m7/pages/p1.jpg-x` },
        { page: 2, text: "", needsOcr: true },
      ],
    });
    expect(outcome).toStrictEqual({ name: "scan.pdf", status: "ready", documentId: 31, pageCount: 2, ocrPages: 2 });
  });

  it("registers a PDF without pages as it is, as the browser does", async () => {
    const f = fakes({ extractPdf: [{ pages: [], images: new Map() }], process: [ready(0)] });
    const outcome = await uploadDocument(planned("empty.pdf", "pdf"), CTX, f.deps);
    expect(f.api.ingest.mock.calls).toStrictEqual([[7, 31, { kind: "pdf", pages: [] }]]);
    expect(outcome).toStrictEqual({ name: "empty.pdf", status: "ready", documentId: 31, pageCount: 0, ocrPages: 0 });
  });

  it("uploads every rendered page of a scan, and leaves it processing once maxWaitMs has passed", async () => {
    const f = fakes({
      extractPdf: [SCAN],
      ingest: [{ ocrPages: 2 }],
      process: [processing(2), processing(2), processing(1), processing(1)],
    });
    const outcome = await uploadDocument(planned("bundle.pdf", "pdf"), CTX, { ...f.deps, maxWaitMs: 3000 });

    expect(f.calls).toEqual([
      "readFile",
      "uploadBlob(matters/u42/m7/bundle.pdf)",
      "extractPdf",
      "uploadBlob(matters/u42/m7/pages/p1.jpg)",
      "uploadBlob(matters/u42/m7/pages/p2.jpg)",
      "createDocument",
      "ingest",
      // At 0, 1.5, 3 and 4.5 s: past 3 s after the fourth poll.
      "process",
      "sleep(1500)",
      "process",
      "sleep(1500)",
      "process",
      "sleep(1500)",
      "process",
    ]);
    expect(f.uploadBlob.mock.calls.map(([args]) => [args.pathname, args.bytes])).toEqual([
      ["matters/u42/m7/bundle.pdf", PDF_BYTES],
      ["matters/u42/m7/pages/p1.jpg", JPEG_P1],
      ["matters/u42/m7/pages/p2.jpg", JPEG_P2],
    ]);
    expect(f.api.ingest.mock.calls[0][2]).toStrictEqual({
      kind: "pdf",
      pages: [
        { page: 1, text: "", needsOcr: true, imageBlobKey: `${STORE}matters/u42/m7/pages/p1.jpg-x` },
        { page: 2, text: "Σφραγίδα", needsOcr: true, imageBlobKey: `${STORE}matters/u42/m7/pages/p2.jpg-x` },
      ],
    });
    // A line when the count changes, not one per poll.
    expect(f.log.mock.calls).toEqual([["bundle.pdf: OCR, 2 page(s) remaining"], ["bundle.pdf: OCR, 1 page(s) remaining"]]);
    expect(outcome).toStrictEqual({
      name: "bundle.pdf",
      status: "processing",
      documentId: 31,
      ocrRemaining: 1,
      message: STILL_PROCESSING,
    });
  });

  it("waits ten minutes by default, polling every 1.5 s", async () => {
    const f = fakes({ process: Array.from({ length: 500 }, () => processing(40)) });
    const outcome = await uploadDocument(planned("bundle.pdf", "pdf"), CTX, f.deps);

    // Polls at 0, 1.5 s, …, 601.5 s: the first one past 600 s ends the wait.
    expect(f.api.process).toHaveBeenCalledTimes(402);
    expect(f.sleep.mock.calls).toEqual(Array.from({ length: 401 }, () => [1500]));
    expect(f.log.mock.calls).toEqual([["bundle.pdf: OCR, 40 page(s) remaining"]]);
    expect(outcome).toStrictEqual({
      name: "bundle.pdf",
      status: "processing",
      documentId: 31,
      ocrRemaining: 40,
      message: STILL_PROCESSING,
    });
  });

  it("takes the page count it knows when the ready answer carries no document", async () => {
    const f = fakes({ process: [{ status: "ready", ocrRemaining: 0 }] });
    const outcome = await uploadDocument(planned("claim.pdf", "pdf"), CTX, f.deps);
    expect(outcome).toStrictEqual({ name: "claim.pdf", status: "ready", documentId: 31, pageCount: 2, ocrPages: 0 });
  });
});

describe("uploadDocument: the poll", () => {
  it("polls on when another poll holds the batch (409 processing_in_progress)", async () => {
    const f = fakes({ process: [new ApiError(409, "processing_in_progress"), ready(2)] });
    const outcome = await uploadDocument(planned("claim.pdf", "pdf"), CTX, f.deps);

    expect(f.calls.slice(-4)).toEqual(["ingest", "process", "sleep(1500)", "process"]);
    expect(f.log).not.toHaveBeenCalled();
    expect(outcome).toStrictEqual({ name: "claim.pdf", status: "ready", documentId: 31, pageCount: 2, ocrPages: 0 });
  });

  it("logs the OCR count only when it changes, and finalizing once it is 0", async () => {
    const f = fakes({
      ingest: [{ ocrPages: 3 }],
      process: [processing(3), processing(3), processing(1), processing(0), processing(0), ready(2)],
    });
    await uploadDocument(planned("claim.pdf", "pdf"), CTX, f.deps);
    expect(f.log.mock.calls).toEqual([
      ["claim.pdf: OCR, 3 page(s) remaining"],
      ["claim.pdf: OCR, 1 page(s) remaining"],
      ["claim.pdf: finalizing"],
    ]);
  });

  it.each([
    ["a request that got no answer", new TypeError("fetch failed")],
    ["a 500", new ApiError(500, "http_500")],
    ["a 503", new ApiError(503, "http_503")],
    ["a 429", new ApiError(429, "Too many requests")],
  ])("polls on after %s, and follows the document to ready", async (_what, blip) => {
    const f = fakes({ process: [processing(1), blip, ready(2)] });
    const outcome = await uploadDocument(planned("claim.pdf", "pdf"), CTX, f.deps);
    expect(f.calls.slice(-6)).toEqual(["ingest", "process", "sleep(1500)", "process", "sleep(1500)", "process"]);
    expect(outcome).toStrictEqual({ name: "claim.pdf", status: "ready", documentId: 31, pageCount: 2, ocrPages: 0 });
  });

  const unavailable = () => new ApiError(503, "http_503");
  it.each([
    [
      "never comes back",
      [processing(2), unavailable(), unavailable(), unavailable()],
      `${STILL_PROCESSING} (the last poll failed: 503 http_503)`,
    ],
    ["comes back before the wait ends", [unavailable(), processing(2), processing(2), processing(2)], STILL_PROCESSING],
  ])("leaves the document processing when the server %s", async (_what, answers, message) => {
    const f = fakes({ ingest: [{ ocrPages: 3 }], process: answers });
    const outcome = await uploadDocument(planned("claim.pdf", "pdf"), CTX, { ...f.deps, maxWaitMs: 3000 });
    // At 0, 1.5, 3 and 4.5 s: past 3 s after the fourth poll. The count is the last one answered.
    expect(f.api.process).toHaveBeenCalledTimes(4);
    expect(outcome).toStrictEqual({ name: "claim.pdf", status: "processing", documentId: 31, ocrRemaining: 2, message });
  });

  it("ends on any other 409 from the poll", async () => {
    const f = fakes({ process: [new ApiError(409, "Document is not processing")] });
    const outcome = await uploadDocument(planned("claim.pdf", "pdf"), CTX, f.deps);
    expect(f.api.process).toHaveBeenCalledTimes(1);
    expect(outcome).toStrictEqual({
      name: "claim.pdf",
      status: "failed",
      documentId: 31,
      code: "Document is not processing",
      message: "409 Document is not processing",
    });
  });

  it.each([
    [
      { status: "failed", ocrRemaining: 0, errorCode: "no_text_extracted" } satisfies ProcessResult,
      { code: "no_text_extracted", message: "No readable text found — the pages appear to be blank" },
    ],
    [{ status: "failed", ocrRemaining: 3 } satisfies ProcessResult, { code: "processing_failed" }],
  ])("reports a failed processing with its code: %j", async (result, expected) => {
    const f = fakes({ process: [processing(3), result] });
    const outcome = await uploadDocument(planned("claim.pdf", "pdf"), CTX, f.deps);
    expect(outcome).toStrictEqual({ name: "claim.pdf", status: "failed", documentId: 31, ...expected });
  });
});

describe("uploadDocument: a file already in the matter", () => {
  it("reports a duplicate whose twin is ready, with the twin's id", async () => {
    const f = fakes({ createDocument: [duplicateOf(12)], getDocument: [twin("ready")] });
    const outcome = await uploadDocument(planned("claim.pdf", "pdf"), { ...CTX, role: "exhibit" }, f.deps);

    expect(f.calls).toEqual([
      "readFile",
      "uploadBlob(matters/u42/m7/claim.pdf)",
      "extractPdf",
      "uploadBlob(matters/u42/m7/pages/p2.jpg)",
      "createDocument",
      "getDocument",
    ]);
    expect(f.api.getDocument.mock.calls).toEqual([[7, 12]]);
    expect(outcome).toStrictEqual({
      name: "claim.pdf",
      status: "duplicate",
      documentId: 12,
      message: "This file is already in the matter (document #12).",
    });
  });

  it.each(["processing", "failed"] as const)("resumes the processing of a %s twin and follows it to ready", async (status) => {
    const f = fakes({ createDocument: [duplicateOf(12)], getDocument: [twin(status)], process: [processing(1), ready(2)] });
    // Resumed, the twin is polled as it is, then given the role once it is ready, as a new document would be.
    const outcome = await uploadDocument(planned("claim.pdf", "pdf"), { ...CTX, role: "exhibit" }, f.deps);

    expect(f.calls.slice(4)).toEqual(["createDocument", "getDocument", "process", "sleep(1500)", "process", "patchDocument"]);
    expect(f.api.process.mock.calls).toEqual([
      [7, 12],
      [7, 12],
    ]);
    expect(f.api.patchDocument.mock.calls).toStrictEqual([[7, 12, { role: "exhibit" }]]);
    expect(outcome).toStrictEqual({ name: "claim.pdf", status: "ready", documentId: 12, pageCount: 2, roleApplied: true });
  });

  it("ingests the manifest it built into a pending twin, then polls it", async () => {
    const f = fakes({
      createDocument: [duplicateOf(12)],
      getDocument: [twin("pending")],
      ingest: [{ ocrPages: 1 }],
      process: [processing(1), ready(2)],
    });
    // A run that died between the create and the ingest left the twin pending.
    const outcome = await uploadDocument(planned("claim.pdf", "pdf"), { ...CTX, side: "ours" }, f.deps);

    expect(f.calls.slice(4)).toEqual([
      "createDocument",
      "getDocument",
      "ingest",
      "process",
      "sleep(1500)",
      "process",
      "patchDocument",
    ]);
    expect(f.api.patchDocument.mock.calls).toStrictEqual([[7, 12, { side: "ours" }]]);
    expect(f.api.ingest.mock.calls).toStrictEqual([
      [
        7,
        12,
        {
          kind: "pdf",
          pages: [
            { page: 1, text: TWO_PAGES.pages[0].text, needsOcr: false },
            { page: 2, text: "", needsOcr: true, imageBlobKey: `${STORE}matters/u42/m7/pages/p2.jpg-x` },
          ],
        },
      ],
    ]);
    expect(f.api.process.mock.calls).toEqual([
      [7, 12],
      [7, 12],
    ]);
    expect(outcome).toStrictEqual({
      name: "claim.pdf",
      status: "ready",
      documentId: 12,
      pageCount: 2,
      ocrPages: 1,
      roleApplied: true,
    });
  });

  it.each([
    [401, "Authentication required"],
    [403, "entitlement_required"],
    [404, "Not found"],
  ])("reports a duplicate with the twin's id when the twin's read is refused with %i", async (status, code) => {
    const f = fakes({ createDocument: [duplicateOf(12)], getDocument: [new ApiError(status, code)] });
    const outcome = await uploadDocument(planned("claim.pdf", "pdf"), CTX, f.deps);
    expect(f.calls.slice(4)).toEqual(["createDocument", "getDocument"]);
    expect(outcome).toStrictEqual({
      name: "claim.pdf",
      status: "duplicate",
      documentId: 12,
      message: "This file is already in the matter (document #12).",
    });
  });

  it("fails when the twin's read gets no answer", async () => {
    const f = fakes({ createDocument: [duplicateOf(12)], getDocument: [new TypeError("fetch failed")] });
    const outcome = await uploadDocument(planned("claim.pdf", "pdf"), CTX, f.deps);
    expect(outcome).toStrictEqual({ name: "claim.pdf", status: "failed", documentId: 12, code: "network", message: "fetch failed" });
  });

  it("reports a duplicate without an id when the refusal names no twin", async () => {
    const f = fakes({ createDocument: [new ApiError(409, "duplicate_document")] });
    const outcome = await uploadDocument(planned("claim.pdf", "pdf"), CTX, f.deps);
    expect(f.api.getDocument).not.toHaveBeenCalled();
    expect(outcome).toStrictEqual({ name: "claim.pdf", status: "duplicate", message: "This file is already in the matter." });
  });

  it("resumes the processing twin of a text document", async () => {
    const f = fakes({
      readFile: [utf8("Σημείωμα για τη δικάσιμο.")],
      createTextDocument: [duplicateOf(12)],
      getDocument: [twin("processing")],
      process: [ready(1)],
    });
    const outcome = await uploadDocument(planned("σημείωμα.txt", "text"), CTX, f.deps);
    expect(f.calls).toEqual(["readFile", "createTextDocument", "getDocument", "process"]);
    expect(outcome).toStrictEqual({ name: "σημείωμα.txt", status: "ready", documentId: 12, pageCount: 1 });
  });
});

describe("uploadDocument: role and side", () => {
  it.each([
    [{ role: "statement_of_claim" }, { role: "statement_of_claim" }],
    [{ side: "theirs" }, { side: "theirs" }],
    [{ role: "exhibit", side: "ours" }, { role: "exhibit", side: "ours" }],
  ])("patches %j once the processing is ready, over the server's own suggestion", async (given, body) => {
    const f = fakes();
    const outcome = await uploadDocument(planned("claim.pdf", "pdf"), { ...CTX, ...given }, f.deps);

    expect(f.calls.slice(4)).toEqual(["createDocument", "ingest", "process", "patchDocument"]);
    expect(f.api.patchDocument.mock.calls).toStrictEqual([[7, 31, body]]);
    expect(outcome).toStrictEqual({
      name: "claim.pdf",
      status: "ready",
      documentId: 31,
      pageCount: 2,
      ocrPages: 0,
      roleApplied: true,
    });
  });

  it.each([
    ["a 401", new ApiError(401, "Authentication required", { email: "eleni@example.com" }), "refused with 401"],
    ["a 403", new ApiError(403, "email_not_verified", { email: "eleni@example.com" }), "refused with 403"],
    ["a 500", new ApiError(500, "http_500"), "refused with 500"],
    ["a request that got no answer", new TypeError("fetch failed\n    at node:internal/deps/undici:1:1"), "failed: fetch failed"],
  ])("keeps the document ready without the role when the patch meets %s, and logs one line", async (_what, err, why) => {
    const f = fakes({ patchDocument: [err] });
    const outcome = await uploadDocument(planned("claim.pdf", "pdf"), { ...CTX, role: "exhibit" }, f.deps);

    expect(f.calls.slice(4)).toEqual(["createDocument", "ingest", "process", "patchDocument"]);
    expect(f.log.mock.calls).toEqual([
      [`claim.pdf: role/side not applied (PATCH /api/matters/7/documents/31 ${why})`],
    ]);
    expect(outcome).toStrictEqual({
      name: "claim.pdf",
      status: "ready",
      documentId: 31,
      pageCount: 2,
      ocrPages: 0,
      roleApplied: false,
    });
  });

  it.each([
    [
      "left processing at the end of the wait",
      { process: [processing(2), processing(2), processing(1), processing(1)] },
      { status: "processing", ocrRemaining: 1, message: STILL_PROCESSING },
    ],
    [
      "failed in its processing",
      { process: [{ status: "failed", ocrRemaining: 0, errorCode: "no_text_extracted" } satisfies ProcessResult] },
      { status: "failed", code: "no_text_extracted", message: "No readable text found — the pages appear to be blank" },
    ],
  ] satisfies Array<[string, Answers, Partial<DocumentOutcome>]>)(
    "does not patch a document %s, and says the role is not applied",
    async (_what, answers, ended) => {
      const f = fakes(answers);
      const outcome = await uploadDocument(planned("claim.pdf", "pdf"), { ...CTX, side: "ours" }, { ...f.deps, maxWaitMs: 3000 });

      expect(f.api.patchDocument).not.toHaveBeenCalled();
      expect(outcome).toStrictEqual({ name: "claim.pdf", documentId: 31, ...ended, roleApplied: false });
    },
  );

  it("does not patch a twin that is ready already, which keeps its own role", async () => {
    const f = fakes({ createDocument: [duplicateOf(12)], getDocument: [twin("ready")] });
    const outcome = await uploadDocument(planned("claim.pdf", "pdf"), { ...CTX, role: "exhibit" }, f.deps);

    expect(f.api.patchDocument).not.toHaveBeenCalled();
    expect(outcome).toStrictEqual({
      name: "claim.pdf",
      status: "duplicate",
      documentId: 12,
      message: "This file is already in the matter (document #12).",
    });
  });

  it("patches a text document's role once it is ready", async () => {
    const f = fakes({ readFile: [utf8("Επιστολή προς τον συνήγορο της άλλης πλευράς.")], process: [ready(1)] });
    const outcome = await uploadDocument(planned("επιστολή.md", "text"), { ...CTX, role: "correspondence" }, f.deps);

    expect(f.calls).toEqual(["readFile", "createTextDocument", "process", "patchDocument"]);
    expect(f.api.patchDocument.mock.calls).toStrictEqual([[7, 32, { role: "correspondence" }]]);
    expect(outcome).toStrictEqual({
      name: "επιστολή.md",
      status: "ready",
      documentId: 32,
      pageCount: 1,
      roleApplied: true,
    });
  });
});

describe("uploadDocument: a text document", () => {
  it("decodes a windows-1253 file and posts its text normalised, then polls it", async () => {
    const f = fakes({ readFile: [GREEK_1253], process: [ready(1)] });
    const outcome = await uploadDocument(planned("σημείωμα.txt", "text"), CTX, f.deps);

    expect(f.calls).toEqual(["readFile", "createTextDocument", "process"]);
    expect(f.api.createTextDocument.mock.calls).toStrictEqual([
      [7, { filename: "σημείωμα.txt", text: "Αγωγή\nαρ. 112" }],
    ]);
    expect(f.api.process.mock.calls).toEqual([[7, 32]]);
    expect(outcome).toStrictEqual({ name: "σημείωμα.txt", status: "ready", documentId: 32, pageCount: 1 });
  });

  it.each([
    [
      "bytes that decode neither as UTF-8 nor as windows-1253",
      new Uint8Array([0x41, 0xff]),
      "text_encoding",
      "This file is not UTF-8 text — save it as UTF-8 or upload it as PDF/DOCX",
    ],
    ["a file of whitespace only", utf8("\uFEFF \r\n\t\r\n"), "text_empty", "The file is empty"],
    [
      "a text one character over the cap",
      utf8("α".repeat(200_001)),
      "text_too_long",
      "Too long to save as text — upload it as a file",
    ],
  ])("skips %s, sending nothing", async (_what, bytes, code, message) => {
    const f = fakes({ readFile: [bytes] });
    const outcome = await uploadDocument(planned("notes.txt", "text"), CTX, f.deps);
    expect(f.calls).toEqual(["readFile"]);
    expect(outcome).toStrictEqual({ name: "notes.txt", status: "skipped", code, message });
  });

  it("posts a text at the cap", async () => {
    const f = fakes({ readFile: [utf8("α".repeat(200_000))] });
    await uploadDocument(planned("notes.txt", "text"), CTX, f.deps);
    expect(f.api.createTextDocument.mock.calls).toEqual([[7, { filename: "notes.txt", text: "α".repeat(200_000) }]]);
  });
});

describe("uploadDocument: failures", () => {
  it("names the plan's limit when the matter is full (429 document_limit_reached)", async () => {
    const f = fakes({ createDocument: [new ApiError(429, "document_limit_reached", { limit: 10 })] });
    const outcome = await uploadDocument(planned("claim.pdf", "pdf"), CTX, f.deps);
    expect(outcome).toStrictEqual({
      name: "claim.pdf",
      status: "failed",
      code: "document_limit_reached",
      message: "Document limit reached (10 per matter).",
    });
  });

  const refused = () => new ApiError(401, "Authentication required");
  it.each([
    ["the blob token", planned("claim.pdf", "pdf"), { uploadBlob: [refused()] }, "POST /api/matters/7/documents/upload", {}],
    ["the create", planned("claim.pdf", "pdf"), { createDocument: [refused()] }, "POST /api/matters/7/documents", {}],
    [
      "the ingest",
      planned("claim.pdf", "pdf"),
      { ingest: [refused()] },
      "POST /api/matters/7/documents/31/ingest",
      { documentId: 31 },
    ],
    [
      "a poll",
      planned("claim.pdf", "pdf"),
      { process: [processing(1), refused()] },
      "POST /api/matters/7/documents/31/process",
      { documentId: 31 },
    ],
    [
      "the text create",
      planned("notes.txt", "text"),
      { readFile: [utf8("Σημείωμα.")], createTextDocument: [refused()] },
      "POST /api/matters/7/documents/text",
      {},
    ],
  ] satisfies Array<[string, PlanEntry, Answers, string, { documentId?: number }]>)(
    "names the route when %s is refused after the client's retry (401)",
    async (_step, entry, answers, route, known) => {
      const f = fakes(answers);
      const outcome = await uploadDocument(entry, CTX, f.deps);
      expect(outcome).toStrictEqual({
        name: entry.name,
        status: "failed",
        ...known,
        code: "unauthorized",
        message: `The server refused the helper's sign-in for ${route}; this route may not accept helper tokens yet (docs/assumed-routes.md)`,
      });
    },
  );

  it("asks for a new sign-in when there was no token to send (not_signed_in)", async () => {
    const f = fakes({ process: [new ApiError(401, "not_signed_in")] });
    const outcome = await uploadDocument(planned("claim.pdf", "pdf"), CTX, f.deps);
    expect(outcome).toStrictEqual({
      name: "claim.pdf",
      status: "failed",
      documentId: 31,
      code: "not_signed_in",
      message: "Sign in again: call the tool once more and follow the sign-in instructions.",
    });
  });

  it.each([
    [{ message: "upload timed out" }, "502 blob_upload_failed: upload timed out"],
    [{}, "502 blob_upload_failed"],
  ])("adds the store's own message to a failed blob upload: %j", async (metadata, message) => {
    const f = fakes({ uploadBlob: [new ApiError(502, "blob_upload_failed", metadata)] });
    const outcome = await uploadDocument(planned("claim.pdf", "pdf"), CTX, f.deps);
    expect(outcome).toStrictEqual({ name: "claim.pdf", status: "failed", code: "blob_upload_failed", message });
  });

  it("keeps the error's metadata out of the message", async () => {
    const f = fakes({ createDocument: [new ApiError(403, "email_not_verified", { email: "eleni@example.com" })] });
    const outcome = await uploadDocument(planned("claim.pdf", "pdf"), CTX, f.deps);
    expect(outcome).toStrictEqual({
      name: "claim.pdf",
      status: "failed",
      code: "email_not_verified",
      message: "Verify this DIKIGOROS account's email address first, then try again.",
    });
  });

  it("reports a file that could not be read as unreadable, with the first line of its error", async () => {
    const message = "EACCES: permission denied, open '/Users/eleni/Matters/Georgiou/claim.pdf'";
    const f = fakes({ readFile: [Object.assign(new Error(`${message}\n    at async open (node:internal/fs/promises:639:25)`), { code: "EACCES" })] });
    const outcome = await uploadDocument(planned("claim.pdf", "pdf"), CTX, f.deps);
    expect(f.calls).toEqual(["readFile"]);
    expect(outcome).toStrictEqual({ name: "claim.pdf", status: "failed", code: "unreadable", message });
  });

  it.each([
    ["a corrupt PDF", planned("claim.pdf", "pdf"), { extractPdf: [new Error("Invalid PDF structure.")] }, "Invalid PDF structure."],
    [
      "a zip that is not a DOCX",
      planned("υπεράσπιση.docx", "docx"),
      {
        readFile: [DOCX_BYTES],
        extractDocx: [new Error("Could not find main document part. Are you sure this is a valid .docx file?")],
      },
      "Could not find main document part. Are you sure this is a valid .docx file?",
    ],
  ] satisfies Array<[string, PlanEntry, Answers, string]>)(
    "reports %s as extraction_failed, before anything is registered",
    async (_what, entry, answers, message) => {
      const f = fakes(answers);
      const outcome = await uploadDocument(entry, CTX, f.deps);
      expect(f.api.createDocument).not.toHaveBeenCalled();
      expect(outcome).toStrictEqual({ name: entry.name, status: "failed", code: "extraction_failed", message });
    },
  );

  it("reports a request that got no answer as network, with the first line of its error", async () => {
    const f = fakes({ createDocument: [new TypeError("fetch failed\n    at node:internal/deps/undici/undici:13510:13")] });
    const outcome = await uploadDocument(planned("claim.pdf", "pdf"), CTX, f.deps);
    expect(outcome).toStrictEqual({ name: "claim.pdf", status: "failed", code: "network", message: "fetch failed" });
  });

  it("does not read an entry the plan skips", async () => {
    const f = fakes();
    const entry: PlanEntry = { ...planned("huge.pdf", "pdf"), decision: "skip", reason: "too_large" };
    const outcome = await uploadDocument(entry, CTX, f.deps);
    expect(f.calls).toEqual([]);
    expect(outcome).toStrictEqual({ name: "huge.pdf", status: "skipped", code: "too_large" });
  });
});
