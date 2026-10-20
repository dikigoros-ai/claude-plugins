// One document end to end, the way the web uploader does it: uploadOne, addText, addTextFile,
// pollProcess and failureOf of dikigoros-ai/dikigoros-ai components/matters/use-document-upload.ts
// @ 37f39ac5 (2026-10-19), ported to Node for one document per call, with an outcome in place of
// React state. The server never parses a file: the helper hashes it, puts its bytes in the private
// blob store, extracts the text and the scanned pages' images here, registers the document, hands
// over the manifest and polls the processing until it is ready. A .txt or .md is posted as text.

import { createHash } from "node:crypto";
import type { BlobContentType, uploadBlob } from "../api/blob-upload";
import type { DikigorosApi, IngestManifest, MatterDocumentRecord, ProcessResult } from "../api/client";
import { ApiError, describeApiError } from "../api/errors";
import type { extractDocx } from "../extract/docx";
import type { ExtractedPdf } from "../extract/pdf";
import { headBytesBase64 } from "../extract/sniff";
import { decodeTextBytes, MAX_TEXT_DOCUMENT_CHARS, normalizeTextDocument } from "../extract/text";
import type { PlanEntry } from "../files/resolve";

/** Between two polls of the processing, as in the browser. */
export const POLL_INTERVAL_MS = 1500;
/** How long the polls run before a document is left processing, for the matter page to resume. */
export const DEFAULT_MAX_WAIT_MS = 10 * 60 * 1000;

export interface UploadContext {
  /** The API's origin, for the sentences that link to it. */
  baseUrl: string;
  /** The signed-in user: a matter's blobs lie under matters/u<userId>/m<matterId>/. */
  userId: number;
  matterId: number;
  /** Set with a PATCH right after the document is created, when given. */
  role?: string;
  side?: string;
}

export interface UploadDeps {
  /** The REST client: it sends the session's bearer and answers a 401 once with a fresh token. */
  api: DikigorosApi;
  uploadBlob: typeof uploadBlob;
  /** extractPdf bound to the canvas module and pdf.js's assets. */
  extractPdf: (bytes: Uint8Array, onProgress?: (page: number, total: number) => void) => Promise<ExtractedPdf>;
  extractDocx: typeof extractDocx;
  readFile: (path: string) => Promise<Uint8Array>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** POLL_INTERVAL_MS and DEFAULT_MAX_WAIT_MS unless given. */
  pollIntervalMs?: number;
  maxWaitMs?: number;
  /** A line of progress, or of a refusal the upload went on after. */
  log: (line: string) => void;
}

export type OutcomeStatus = "ready" | "processing" | "failed" | "duplicate" | "skipped";

/** What became of one document; a field is there only when it is known. */
export interface DocumentOutcome {
  /** The file's name, which is the document's filename. */
  name: string;
  status: OutcomeStatus;
  /** Once the document exists: ours, or the twin's for a file the matter holds already. */
  documentId?: number;
  /** When ready: the document's pages, and the pages its ingest sent to OCR (when it had one). */
  pageCount?: number;
  ocrPages?: number;
  /** When left processing: the pages still to OCR, as the last poll answered. */
  ocrRemaining?: number;
  /** Why the document failed or was skipped. */
  code?: string;
  /** A sentence for the lawyer: why, or what happens next. */
  message?: string;
  /** When a role or a side was given: whether the server took it; false for a resumed twin, which is not patched. */
  roleApplied?: boolean;
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const STILL_PROCESSING = "still processing; the matter page resumes it, or call again later";

/** The web uploader's sentences for the codes the pipeline reports itself: lib/i18n.ts (en) @ 37f39ac5. */
const SENTENCES: { [code: string]: string | undefined } = {
  text_encoding: "This file is not UTF-8 text — save it as UTF-8 or upload it as PDF/DOCX",
  text_empty: "The file is empty",
  text_too_long: "Too long to save as text — upload it as a file",
  no_text_extracted: "No readable text found — the pages appear to be blank",
};

/** Ported from dikigoros-ai/dikigoros-ai lib/matters.ts @ 37f39ac5: the prefix of all of a matter's blobs. */
export function matterBlobPrefix(userId: number, matterId: number): string {
  return `matters/u${userId}/m${matterId}/`;
}

/**
 * Uploads one planned file into the matter and follows its processing to the end, or for
 * maxWaitMs. Never rejects: every failure is an outcome. An entry the plan skips is not read.
 */
export async function uploadDocument(entry: PlanEntry, ctx: UploadContext, deps: UploadDeps): Promise<DocumentOutcome> {
  if (entry.decision !== "upload" || entry.kind === null) {
    return { name: entry.name, status: "skipped", code: entry.reason ?? "unsupported_type" };
  }
  const upload = new DocumentUpload(entry.name, ctx, deps);
  try {
    // The path the plan checked, its links resolved: a link changed since then is not followed.
    const bytes = await locally("unreadable", () => deps.readFile(entry.realPath));
    return entry.kind === "text" ? await upload.text(bytes) : await upload.file(bytes, entry.kind);
  } catch (err) {
    return upload.failure(err);
  }
}

/** One document on its way through the routes, and what is known of it so far. */
class DocumentUpload {
  readonly #name: string;
  readonly #ctx: UploadContext;
  readonly #deps: UploadDeps;
  readonly #documents: string;
  /** The last route called: the one a refusal is about. */
  #route = "";
  #documentId: number | undefined;
  #roleApplied: boolean | undefined;

  constructor(name: string, ctx: UploadContext, deps: UploadDeps) {
    this.#name = name;
    this.#ctx = ctx;
    this.#deps = deps;
    this.#documents = `/api/matters/${ctx.matterId}/documents`;
  }

  /** A PDF or a DOCX: hash, blob, extraction, page images, create, role, ingest, poll. */
  async file(bytes: Uint8Array, kind: "pdf" | "docx"): Promise<DocumentOutcome> {
    const { api, uploadBlob, extractDocx, extractPdf } = this.#deps;
    const { userId, matterId } = this.#ctx;
    const prefix = matterBlobPrefix(userId, matterId);
    const tokenPath = `${this.#documents}/upload`;
    const put = (pathname: string, body: Uint8Array, contentType: BlobContentType) =>
      this.#call("POST", tokenPath, () => uploadBlob({ api, matterId, pathname, bytes: body, contentType }));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const mimeType = kind === "pdf" ? "application/pdf" : DOCX_MIME;
    // Taken before the bytes go anywhere: an extractor may take over the buffer it is handed (pdf.js does).
    const facts = { sizeBytes: bytes.byteLength, sha256, headBytesBase64: headBytesBase64(bytes) };
    const blob = await put(prefix + this.#name, bytes, mimeType);

    let manifest: IngestManifest;
    let pageCount: number | undefined;
    if (kind === "docx") {
      manifest = { kind: "docx", fullText: (await locally("extraction_failed", () => extractDocx(bytes))).fullText };
    } else {
      const { pages, images } = await locally("extraction_failed", () => extractPdf(bytes));
      // Nothing to read: no page has a text layer and none rendered any ink. The original is in
      // the store already, as in the browser; it goes with the matter.
      if (pages.length > 0 && pages.every((p) => p.needsOcr) && images.size === 0) {
        return this.#outcome("failed", because("no_text_extracted"));
      }
      const withImages: Extract<IngestManifest, { kind: "pdf" }>["pages"] = [];
      for (const { page, text, needsOcr } of pages) {
        const image = needsOcr ? images.get(page) : undefined;
        if (image === undefined) {
          withImages.push({ page, text, needsOcr });
        } else {
          const { url } = await put(`${prefix}pages/p${page}.jpg`, image, "image/jpeg");
          withImages.push({ page, text, needsOcr, imageBlobKey: url });
        }
      }
      manifest = { kind: "pdf", pages: withImages };
      pageCount = pages.length;
    }

    const create = () => api.createDocument(matterId, { filename: this.#name, mimeType, ...facts, blobUrl: blob.url });
    // Our new row, or a twin left pending by a run that died before its ingest: given the manifest, then polled.
    const ingestAndPoll = async (docId: number) => {
      const ingest = () => api.ingest(matterId, docId, manifest);
      const { ocrPages } = await this.#call("POST", `${this.#documents}/${docId}/ingest`, ingest);
      return this.#poll(docId, { pageCount, ocrPages });
    };
    return this.#register(this.#documents, create, (doc) => ingestAndPoll(doc.id), ingestAndPoll);
  }

  /** A .txt or .md: decoded and normalised here, posted as text, its role set, then polled. */
  async text(bytes: Uint8Array): Promise<DocumentOutcome> {
    const decoded = decodeTextBytes(bytes);
    if (decoded === null) return this.#outcome("skipped", because("text_encoding"));
    const text = normalizeTextDocument(decoded);
    if (text === "") return this.#outcome("skipped", because("text_empty"));
    if (text.length > MAX_TEXT_DOCUMENT_CHARS) return this.#outcome("skipped", because("text_too_long"));
    const create = () => this.#deps.api.createTextDocument(this.#ctx.matterId, { filename: this.#name, text });
    // No ingest: the row is processing already, with its one page.
    return this.#register(`${this.#documents}/text`, create, (doc) => this.#poll(doc.id, { pageCount: doc.pageCount }));
  }

  /** The outcome of the rejection that ended the upload. */
  failure(err: unknown): DocumentOutcome {
    if (err instanceof LocalFailure) return this.#outcome("failed", { code: err.code, message: err.message });
    if (!(err instanceof ApiError)) return this.#outcome("failed", { code: "network", message: firstLine(err) });
    // A 401 that the client's retry with a fresh token did not get past: the route refuses the
    // helper's token (it is not on the connector-token allowlist yet) or the session is dead. A
    // not_signed_in was never sent: there was no token.
    if (err.status === 401 && err.code !== "not_signed_in") {
      const message =
        `The server refused the helper's sign-in for ${this.#route}; ` +
        "this route may not accept helper tokens yet (docs/assumed-routes.md)";
      return this.#outcome("failed", { code: "unauthorized", message });
    }
    // Of the metadata, which can hold the user's email, only the store's own message is shown.
    const detail = err.metadata.message;
    const message = describeApiError(err, this.#ctx.baseUrl);
    const withDetail = err.code === "blob_upload_failed" && typeof detail === "string" && detail !== "";
    return this.#outcome("failed", { code: err.code, message: withDetail ? `${message}: ${detail}` : message });
  }

  /**
   * Creates the row and sets its role, then goes on with `next`; for a file the matter holds
   * already (duplicate_document), the twin's way instead, `ingestPending` for a pending twin.
   */
  async #register(
    path: string,
    create: () => Promise<MatterDocumentRecord>,
    next: (doc: MatterDocumentRecord) => Promise<DocumentOutcome>,
    ingestPending?: (twinId: number) => Promise<DocumentOutcome>,
  ): Promise<DocumentOutcome> {
    let doc: MatterDocumentRecord;
    try {
      doc = await this.#call("POST", path, create);
    } catch (err) {
      if (err instanceof ApiError && err.code === "duplicate_document") return this.#twin(err, ingestPending);
      throw err;
    }
    this.#documentId = doc.id;
    await this.#applyRole(doc.id);
    return next(doc);
  }

  /**
   * The twin a duplicate_document refusal names. One that is processing or failed is polled (its
   * processing resumed, as the matter page would); a pending one, when there is a manifest for it,
   * is given it and polled. A ready twin, or one the server will not show, is a duplicate.
   */
  async #twin(err: ApiError, ingestPending?: (twinId: number) => Promise<DocumentOutcome>): Promise<DocumentOutcome> {
    const duplicate = () => this.#outcome("duplicate", { message: describeApiError(err, this.#ctx.baseUrl) });
    const twinId = err.metadata.documentId;
    if (typeof twinId !== "number") return duplicate();
    this.#documentId = twinId;
    const read = () => this.#deps.api.getDocument(this.#ctx.matterId, twinId);
    const twin = await this.#call("GET", `${this.#documents}/${twinId}`, read).catch(refusedRead);
    // A resumed twin is not ours to re-role: a role or a side given is not applied to it.
    const resume = (next: () => Promise<DocumentOutcome>) => {
      if (this.#ctx.role !== undefined || this.#ctx.side !== undefined) this.#roleApplied = false;
      return next();
    };
    if (twin?.ingestStatus === "processing" || twin?.ingestStatus === "failed") {
      return resume(() => this.#poll(twinId, { pageCount: twin.pageCount }));
    }
    if (twin?.ingestStatus === "pending" && ingestPending) return resume(() => ingestPending(twinId));
    return duplicate();
  }

  /** Sets the role and the side given, right after creation; a 401 or a 403 leaves them unset. */
  async #applyRole(docId: number): Promise<void> {
    const { matterId, role, side } = this.#ctx;
    if (role === undefined && side === undefined) return;
    const input: { role?: string; side?: string } = {};
    if (role !== undefined) input.role = role;
    if (side !== undefined) input.side = side;
    const path = `${this.#documents}/${docId}`;
    try {
      await this.#call("PATCH", path, () => this.#deps.api.patchDocument(matterId, docId, input));
      this.#roleApplied = true;
    } catch (err) {
      if (!(err instanceof ApiError && (err.status === 401 || err.status === 403))) throw err;
      this.#roleApplied = false;
      this.#deps.log(`${this.#name}: role/side not applied (PATCH ${path} refused with ${err.status})`);
    }
  }

  /**
   * Runs the processing a batch at a time, a poll every pollIntervalMs, until the document is
   * ready or failed; after maxWaitMs of polling it is left processing, the row still resumable.
   */
  async #poll(docId: number, known: { pageCount?: number; ocrPages?: number }): Promise<DocumentOutcome> {
    const { api, sleep, now, log, pollIntervalMs = POLL_INTERVAL_MS, maxWaitMs = DEFAULT_MAX_WAIT_MS } = this.#deps;
    const path = `${this.#documents}/${docId}/process`;
    const start = now();
    let ocrRemaining = known.ocrPages;
    let logged: number | undefined;
    let lastFailure: string | undefined; // the first line of the transient failure the last poll ended in
    for (;;) {
      let result: ProcessResult | undefined;
      try {
        result = await this.#call("POST", path, () => api.process(this.#ctx.matterId, docId));
        lastFailure = undefined;
      } catch (err) {
        lastFailure = pollAgainAfter(err);
      }
      if (result?.status === "ready") {
        const pageCount = result.document?.pageCount ?? known.pageCount;
        return this.#outcome("ready", { pageCount, ocrPages: known.ocrPages });
      }
      if (result?.status === "failed") return this.#outcome("failed", because(result.errorCode ?? "processing_failed"));
      if (result) {
        ocrRemaining = result.ocrRemaining;
        // A line when the count changes, not one per poll.
        if (ocrRemaining !== logged) {
          log(ocrRemaining > 0 ? `${this.#name}: OCR, ${ocrRemaining} page(s) remaining` : `${this.#name}: finalizing`);
        }
        logged = ocrRemaining;
      }
      if (now() - start > maxWaitMs) {
        const failed = lastFailure === undefined ? "" : ` (the last poll failed: ${lastFailure})`;
        return this.#outcome("processing", { ocrRemaining, message: STILL_PROCESSING + failed });
      }
      await sleep(pollIntervalMs);
    }
  }

  /** Makes one call to `method path`, the route a refusal of it is then about. */
  async #call<T>(method: string, path: string, call: () => Promise<T>): Promise<T> {
    this.#route = `${method} ${path}`;
    return call();
  }

  /** The outcome: the document's id and the patch's result as far as known, then `fields`. */
  #outcome(status: OutcomeStatus, fields: Omit<DocumentOutcome, "name" | "status"> = {}): DocumentOutcome {
    const known = { documentId: this.#documentId, roleApplied: this.#roleApplied, ...fields };
    const defined = Object.fromEntries(Object.entries(known).filter(([, value]) => value !== undefined));
    return { name: this.#name, status, ...(defined as typeof fields) };
  }
}

/** A local step's rejection: the read (unreadable) or an extractor (extraction_failed), with its first line. */
class LocalFailure extends Error {
  constructor(readonly code: "unreadable" | "extraction_failed", cause: unknown) {
    super(firstLine(cause), { cause });
  }
}

/** Runs a local step; its rejection becomes a LocalFailure with `code`. */
async function locally<T>(code: LocalFailure["code"], step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    throw new LocalFailure(code, err);
  }
}

/**
 * A rejected poll that is polled again: a lost concurrency claim (another poll runs the same
 * batch) leaves nothing behind, a transient failure (no answer, a 5xx, a 429) its first line. Any
 * other refusal ends the upload.
 */
function pollAgainAfter(err: unknown): string | undefined {
  if (err instanceof ApiError && err.status === 409 && err.code === "processing_in_progress") return undefined;
  if (!(err instanceof ApiError) || err.status >= 500 || err.status === 429) return firstLine(err);
  throw err;
}

/** A twin the server will not show (401, 403, 404) is a duplicate all the same: no twin to follow. */
function refusedRead(err: unknown): undefined {
  if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404)) return undefined;
  throw err;
}

/** `code`, with the web uploader's sentence for it when there is one. */
function because(code: string): { code: string; message?: string } {
  return { code, message: SENTENCES[code] };
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split(/\r?\n/, 1)[0];
}
