// An in-memory DIKIGOROS API and private blob store over http on 127.0.0.1, for the integration
// test. The API answers the routes the helper calls as the main app's routes do
// (dikigoros-ai/dikigoros-ai app/api/matters/** and app/auth/current-user @ 37f39ac5, 2026-10-19)
// for one signed-in user whose plan includes Matters: the bearer first, then their checks of the
// ids and the body in their order, with their statuses, error bodies and answer shapes. Left out
// are the checks the helper cannot fail here: the feature flag, the entitlement, the weekly usage
// quota and the ingest route's caps on pages and text. The store takes a PUT as @vercel/blob
// 2.8.2's client sends it: the blob's pathname in the query and, as the bearer, the client token the
// API handed out for that pathname. Every request is recorded with its JSON body (for the store's
// PUT, the blob's pathname, type and size) and what the fake answered. Nothing is printed.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { MAX_TEXT_DOCUMENT_CHARS, normalizeTextDocument } from "../../src/extract/text";
import { MAX_FILE_BYTES } from "../../src/files/resolve";
import { MATTER_SIDES, MATTER_TYPES, MATTER_UPLOAD_ROLES } from "../../src/server/tools";

/** The one bearer the API takes: any other, or none, is answered 401. */
export const TEST_TOKEN = "test-token";

/** The signed-in user. */
export const FAKE_USER = { id: 7, email: "lawyer@example.com", plan: "firm" } as const;

/** The Firm plan's limit of active matters (lib/entitlements.ts @ 37f39ac5). */
const ACTIVE_MATTERS = 10;

/** The store's private host; its id, teststore, is the one in the client tokens (vercel_blob_client_<store id>_…). */
const STORE_HOST = "teststore.private.blob.vercel-storage.com";
/** Where the store listens under the fake's origin: the test sets VERCEL_BLOB_API_URL to `${baseUrl}/blob-store`. */
const STORE_PATH = "/blob-store/";

/** The MIME type the documents route stores for a sniffed kind, never the one the client claims. */
const SNIFFED_MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;

export interface RecordedRequest {
  method: string;
  /** The URL's path, without the query. */
  path: string;
  /** The Authorization header as it came; undefined when there was none. */
  authorization: string | undefined;
  /** An API request's body, parsed as JSON; undefined without one, and for the store's PUT. */
  body: unknown;
  /** The store's PUT only: the blob's pathname (the query's, decoded), its x-content-type and its size in bytes. */
  blob?: { pathname: string; contentType: string | undefined; sizeBytes: number };
  /** The status the fake answered with, and the JSON body it sent. */
  status: number;
  answer: unknown;
}

export interface FakeMatter {
  id: number;
  userId: number;
  title: string;
  caseReference: string;
  matterType: string | null;
  description: string;
  status: "active" | "archived";
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FakeDocument {
  id: number;
  matterId: number;
  filename: string;
  /** From the sniffed head bytes (a file) or from the extension (a text document). */
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  /** The registered blob's URL; null for a text document, which has none. */
  blobUrl: string | null;
  role: string | null;
  side: string | null;
  roleConfirmed: boolean;
  origin: "upload" | "text";
  ingestStatus: "pending" | "processing" | "ready" | "failed";
  /** As ingested: a PDF's manifest pages, or the one page holding a DOCX's or a text document's text. */
  pages: Array<{ page: number; text: string; needsOcr: boolean; imageBlobKey?: string }>;
  /** The polls of …/process so far. */
  polls: number;
  ocrApplied: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FakeApi {
  /** `http://127.0.0.1:<port>`: the helper's base URL. */
  baseUrl: string;
  /** Every request, API and store alike, in the order it came. */
  requests: RecordedRequest[];
  state: {
    matters: Map<number, FakeMatter>;
    documents: Map<number, FakeDocument>;
    /** The store's blobs: each pathname with the size in bytes of the last body PUT there. */
    blobs: Map<string, number>;
  };
  close(): Promise<void>;
}

/** What a create route gives a new document; the rest starts out the same for every one. */
type NewDocument = Omit<FakeDocument, "id" | "role" | "side" | "roleConfirmed" | "polls" | "ocrApplied" | "createdAt" | "updatedAt">;

/** What the fake answers: a status and a JSON body. */
interface Answer {
  status: number;
  body: unknown;
}

type Handler = (ids: number[], body: unknown) => Answer;

/**
 * Starts the fake on a free port of 127.0.0.1. `docsPerMatter` is the plan's limit of documents
 * per matter: 50 (the Firm plan's) unless given, -1 for none. A document's first `ocrBatches`
 * polls of …/process (1 unless given) answer processing, each with the OCR pages left after it
 * (one page a poll); the next poll answers ready.
 */
export async function startFakeApi(opts: { docsPerMatter?: number; ocrBatches?: number } = {}): Promise<FakeApi> {
  const { docsPerMatter = 50, ocrBatches = 1 } = opts;
  const state: FakeApi["state"] = { matters: new Map(), documents: new Map(), blobs: new Map() };
  const requests: RecordedRequest[] = [];
  /** Each client token handed out, with the one pathname it lets the store take. */
  const clientTokens = new Map<string, string>();
  /** The size of the blob behind each URL the store answered with: what the documents route's head() reads. */
  const blobSizes = new Map<string, number>();
  let lastMatterId = 0;
  let lastDocumentId = 0;

  // ---------- The routes ----------

  const currentUser: Handler = () =>
    ok({
      id: FAKE_USER.id,
      email: FAKE_USER.email,
      plan: FAKE_USER.plan,
      entitlements: { mattersAccess: true, docsPerMatter, activeMatters: ACTIVE_MATTERS, tier: FAKE_USER.plan },
    });

  const listMatters: Handler = () =>
    ok({
      matters: ownMatters()
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(({ id, title, caseReference, matterType, status, updatedAt }) => {
          const documentCount = documentsOf(id).length;
          return { id, title, caseReference, matterType, status, updatedAt, documentCount };
        }),
    });

  const createMatter: Handler = (_, body) => {
    if (!isRecord(body)) return refuse(400, "Invalid JSON");
    const title = trimmed(body.title, Infinity);
    if (title === "" || title.length > 300) return refuse(400, "Title required (max 300 chars)");
    if (ownMatters().filter((matter) => matter.status === "active").length >= ACTIVE_MATTERS) {
      return { status: 429, body: { error: "matter_limit_reached", limit: ACTIVE_MATTERS } };
    }
    const now = new Date().toISOString();
    const matter: FakeMatter = {
      id: ++lastMatterId,
      userId: FAKE_USER.id,
      title,
      caseReference: trimmed(body.caseReference, 300),
      matterType: oneOf(MATTER_TYPES, body.matterType) ? body.matterType : null,
      description: trimmed(body.description, 2000),
      status: "active",
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    state.matters.set(matter.id, matter);
    return { status: 201, body: { matter } };
  };

  const getMatter = withMatter((matter) =>
    ok({ matter, documents: documentsOf(matter.id).map(summary), pins: [], notes: [], artifacts: [] }),
  );

  /** POST …/documents/upload: the client token @vercel/blob/client asks for with its generate-client-token event. */
  const uploadToken = withMatter((matter, body) => {
    if (!isRecord(body)) return refuse(400, "Invalid JSON");
    const payload = isRecord(body.payload) ? body.payload : {};
    if (body.type !== "blob.generate-client-token" || typeof payload.pathname !== "string") {
      return refuse(400, "Vercel Blob: Invalid event type");
    }
    const prefix = blobPrefix(matter);
    if (!payload.pathname.startsWith(prefix)) return refuse(400, "Pathname must be under the matter's own blob prefix");
    if (!isPlainKeyUnder(payload.pathname, prefix)) {
      return refuse(400, "Pathname must be a plain key under the matter's own blob prefix: no empty, '.' or '..' segments");
    }
    const clientToken = `vercel_blob_client_teststore_${randomBytes(8).toString("hex")}`;
    clientTokens.set(clientToken, payload.pathname);
    return ok({ type: "blob.generate-client-token", clientToken });
  });

  /** POST …/documents: registers a blob already in the store, as a pending document. */
  const createDocument = withMatter((matter, body) => {
    if (!isRecord(body)) return refuse(400, "Invalid JSON");
    const filename = trimmed(body.filename, Infinity);
    if (filename === "" || filename.length > 255) return refuse(400, "filename required (max 255 chars)");
    const { sizeBytes } = body;
    if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_FILE_BYTES) {
      return refuse(400, "Invalid sizeBytes");
    }
    const sha256 = typeof body.sha256 === "string" ? body.sha256.toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(sha256)) return refuse(400, "Invalid sha256");
    const blobUrl = typeof body.blobUrl === "string" ? body.blobUrl : "";
    if (!isOwnBlobUrl(blobUrl, blobPrefix(matter))) return refuse(400, "blobUrl outside the matter's blob prefix");
    if (typeof body.headBytesBase64 !== "string" || body.headBytesBase64 === "") {
      return refuse(400, "headBytesBase64 required");
    }
    const kind = sniffFileKind(Buffer.from(body.headBytesBase64, "base64"));
    if (kind === null) return refuse(415, "Unsupported file type");
    const stored = blobSizes.get(blobUrl);
    if (stored === undefined) return refuse(400, "Could not verify uploaded blob");
    if (stored !== sizeBytes) return refuse(400, "sizeBytes does not match the uploaded blob");
    const refused = limitOrTwin(matter, sha256);
    if (refused !== null) return refused;
    const document = insert({
      matterId: matter.id,
      filename,
      mimeType: SNIFFED_MIME[kind],
      sizeBytes,
      sha256,
      blobUrl,
      origin: "upload",
      ingestStatus: "pending",
      pages: [],
    });
    return { status: 201, body: { document: curated(document) } };
  });

  /** POST …/documents/text: a .txt or .md from its text, normalised and hashed here, processing at once. */
  const createTextDocument = withMatter((matter, body) => {
    if (!isRecord(body)) return refuse(400, "Invalid JSON");
    const filename = trimmed(body.filename, Infinity);
    const mimeType = filename.length > 0 && filename.length <= 255 ? textDocumentMime(filename) : null;
    if (mimeType === null) return refuse(400, "bad_filename");
    const text = typeof body.text === "string" ? normalizeTextDocument(body.text) : "";
    if (text === "") return refuse(400, "text_empty");
    if (text.length > MAX_TEXT_DOCUMENT_CHARS) {
      return { status: 413, body: { error: "text_too_long", limit: MAX_TEXT_DOCUMENT_CHARS } };
    }
    // The hash is the server's own, over the normalised text.
    const sha256 = createHash("sha256").update(text).digest("hex");
    const refused = limitOrTwin(matter, sha256);
    if (refused !== null) return refused;
    const document = insert({
      matterId: matter.id,
      filename,
      mimeType,
      sizeBytes: Buffer.byteLength(text, "utf8"),
      sha256,
      blobUrl: null,
      origin: "text",
      ingestStatus: "processing",
      pages: [{ page: 1, text, needsOcr: false }],
    });
    return { status: 201, body: { document: curated(document) } };
  });

  const getDocument = withDocument((document) => ok({ document: detail(document) }));

  /** PATCH …/documents/{docId}: the role and the side, which the lawyer's choice confirms. */
  const patchDocument = withDocument((document, body) => {
    if (!isRecord(body)) return refuse(400, "Invalid JSON");
    const { role, side } = body;
    if (role !== undefined && !oneOf(MATTER_UPLOAD_ROLES, role)) return refuse(400, "Invalid role");
    if (side !== undefined && side !== null && !oneOf(MATTER_SIDES, side)) return refuse(400, "Invalid side");
    if (oneOf(MATTER_UPLOAD_ROLES, role)) document.role = role;
    if (side === null || oneOf(MATTER_SIDES, side)) document.side = side;
    document.roleConfirmed = true;
    document.updatedAt = new Date().toISOString();
    return ok({ document: curated(document) });
  });

  /** POST …/documents/{docId}/ingest: a pending document's manifest, after which it is processing. */
  const ingest = withDocument((document, body, matter) => {
    if (document.ingestStatus !== "pending") return refuse(409, "Document is not pending ingest");
    if (!isRecord(body)) return refuse(400, "Invalid JSON");
    let pages: FakeDocument["pages"];
    if (body.kind === "pdf") {
      if (!Array.isArray(body.pages)) return refuse(400, "Invalid pages manifest");
      pages = [];
      for (const entry of body.pages as unknown[]) {
        if (!isRecord(entry)) return refuse(400, "Invalid page entry");
        const { page, text, needsOcr, imageBlobKey } = entry;
        const valid = typeof page === "number" && Number.isInteger(page) && typeof text === "string";
        if (!valid || typeof needsOcr !== "boolean") return refuse(400, "Invalid page entry");
        if (imageBlobKey === undefined) {
          pages.push({ page, text, needsOcr });
        } else if (typeof imageBlobKey === "string" && isOwnBlobUrl(imageBlobKey, blobPrefix(matter))) {
          pages.push({ page, text, needsOcr, imageBlobKey });
        } else {
          return refuse(400, "imageBlobKey outside the matter's own blob prefix");
        }
      }
    } else if (body.kind === "docx") {
      if (typeof body.fullText !== "string") return refuse(400, "fullText required");
      pages = [{ page: 1, text: body.fullText, needsOcr: false }];
    } else {
      return refuse(400, "Invalid manifest kind");
    }
    document.pages = pages;
    document.ingestStatus = "processing";
    document.updatedAt = new Date().toISOString();
    return ok({ ocrPages: pages.filter((page) => page.needsOcr).length });
  });

  /** POST …/documents/{docId}/process: one batch, processing for the first ocrBatches polls, then ready. */
  const processBatch = withDocument((document) => {
    if (document.ingestStatus !== "processing" && document.ingestStatus !== "failed") {
      return refuse(409, "Document is not processing");
    }
    document.polls += 1;
    document.ingestStatus = "processing";
    document.updatedAt = new Date().toISOString();
    const ocrPages = document.pages.filter((page) => page.needsOcr).length;
    if (document.polls <= ocrBatches) {
      return ok({ status: "processing", ocrRemaining: Math.max(0, ocrPages - document.polls) });
    }
    document.ingestStatus = "ready";
    document.ocrApplied = ocrPages > 0;
    const { id, filename, role, side, roleConfirmed, ingestStatus, ocrApplied } = document;
    const extractedText = document.pages.map((page) => page.text).join("\n\n");
    const pageCount = document.pages.length;
    return ok({
      status: "ready",
      ocrRemaining: 0,
      document: { id, filename, role, side, roleConfirmed, ingestStatus, pageCount, ocrApplied, extractedText },
    });
  });

  const ROUTES: Array<{ method: string; pattern: RegExp; handle: Handler }> = [
    { method: "GET", pattern: /^\/auth\/current-user$/, handle: currentUser },
    { method: "GET", pattern: /^\/api\/matters$/, handle: listMatters },
    { method: "POST", pattern: /^\/api\/matters$/, handle: createMatter },
    { method: "GET", pattern: /^\/api\/matters\/(\d+)$/, handle: getMatter },
    { method: "POST", pattern: /^\/api\/matters\/(\d+)\/documents$/, handle: createDocument },
    { method: "POST", pattern: /^\/api\/matters\/(\d+)\/documents\/upload$/, handle: uploadToken },
    { method: "POST", pattern: /^\/api\/matters\/(\d+)\/documents\/text$/, handle: createTextDocument },
    { method: "GET", pattern: /^\/api\/matters\/(\d+)\/documents\/(\d+)$/, handle: getDocument },
    { method: "PATCH", pattern: /^\/api\/matters\/(\d+)\/documents\/(\d+)$/, handle: patchDocument },
    { method: "POST", pattern: /^\/api\/matters\/(\d+)\/documents\/(\d+)\/ingest$/, handle: ingest },
    { method: "POST", pattern: /^\/api\/matters\/(\d+)\/documents\/(\d+)\/process$/, handle: processBatch },
  ];

  /** An API request: the bearer, then the route the method and the path name. */
  function api(method: string, path: string, authorization: string | undefined, body: unknown): Answer {
    if (authorization !== `Bearer ${TEST_TOKEN}`) return refuse(401, "Authentication required");
    for (const route of ROUTES) {
      const match = route.method === method ? route.pattern.exec(path) : null;
      if (match !== null) return route.handle(match.slice(1).map(Number), body);
    }
    return refuse(404, "Not found");
  }

  /**
   * The store's PUT of `blob`: taken when its bearer is a client token handed out for that very
   * pathname. The body is kept as its size; the URL answered is the pathname with a random suffix.
   */
  function store(method: string, authorization: string | undefined, blob: NonNullable<RecordedRequest["blob"]>): Answer {
    if (method !== "PUT") return { status: 405, body: { error: { code: "bad_request", message: "PUT only." } } };
    const { pathname, contentType, sizeBytes } = blob;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
    if (token === undefined || clientTokens.get(token) !== pathname) {
      const error = { code: "forbidden", message: "Access denied, please provide a valid token for this resource." };
      return { status: 403, body: { error } };
    }
    const blobUrl = `https://${STORE_HOST}/${pathname}-${randomBytes(4).toString("hex")}`;
    state.blobs.set(pathname, sizeBytes);
    blobSizes.set(blobUrl, sizeBytes);
    return ok({ url: blobUrl, pathname, contentType, contentDisposition: "" });
  }

  /** Reads the request in full, answers it, and records both. */
  async function receive(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "";
    const { authorization } = req.headers;
    const recorded: RecordedRequest = {
      method,
      path: url.pathname,
      authorization,
      body: undefined,
      status: 0,
      answer: undefined,
    };
    let answer: Answer;
    try {
      if (url.pathname === STORE_PATH) {
        const pathname = url.searchParams.get("pathname") ?? "";
        recorded.blob = { pathname, contentType: header(req, "x-content-type"), sizeBytes: bytes.length };
        answer = store(method, authorization, recorded.blob);
      } else {
        // A body that is not JSON goes on as undefined, which a route that needs one refuses as Invalid JSON.
        recorded.body = bytes.length === 0 ? undefined : parseJson(bytes);
        answer = api(method, url.pathname, authorization, recorded.body);
      }
    } catch (err) {
      answer = refuse(500, `fake API failure: ${err instanceof Error ? err.message : String(err)}`);
    }
    recorded.status = answer.status;
    recorded.answer = answer.body;
    requests.push(recorded);
    res.writeHead(answer.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(answer.body));
  }

  // ---------- The state ----------

  function ownMatters(): FakeMatter[] {
    return [...state.matters.values()].filter((matter) => matter.userId === FAKE_USER.id && matter.deletedAt === null);
  }

  function documentsOf(matterId: number): FakeDocument[] {
    return [...state.documents.values()]
      .filter((document) => document.matterId === matterId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
  }

  /** The user's matter `id`; undefined when it is missing, deleted or someone else's (requireMatter: 404). */
  function ownMatter(id: number): FakeMatter | undefined {
    const matter = state.matters.get(id);
    return matter !== undefined && matter.userId === FAKE_USER.id && matter.deletedAt === null ? matter : undefined;
  }

  /** The handler of a route under /api/matters/{id}: 404 unless the matter is the user's. */
  function withMatter(handle: (matter: FakeMatter, body: unknown) => Answer): Handler {
    return ([matterId], body) => {
      const matter = ownMatter(matterId);
      return matter === undefined ? refuse(404, "Not found") : handle(matter, body);
    };
  }

  /** The handler of a route under …/documents/{docId}: 404 unless the document is in the user's matter. */
  function withDocument(handle: (document: FakeDocument, body: unknown, matter: FakeMatter) => Answer): Handler {
    return ([matterId, docId], body) => {
      const matter = ownMatter(matterId);
      const document = state.documents.get(docId);
      if (matter === undefined || document === undefined || document.matterId !== matter.id) {
        return refuse(404, "Not found");
      }
      return handle(document, body, matter);
    };
  }

  /** The two refusals both create routes make before inserting: the plan's limit, then the same bytes already there. */
  function limitOrTwin(matter: FakeMatter, sha256: string): Answer | null {
    if (docsPerMatter !== -1 && documentsOf(matter.id).length >= docsPerMatter) {
      return { status: 429, body: { error: "document_limit_reached", limit: docsPerMatter } };
    }
    const twin = documentsOf(matter.id).find((document) => document.sha256 === sha256);
    return twin === undefined ? null : { status: 409, body: { error: "duplicate_document", documentId: twin.id } };
  }

  /** A new document of the matter: no role or side yet, not polled. */
  function insert(fields: NewDocument): FakeDocument {
    const now = new Date().toISOString();
    const document: FakeDocument = {
      id: ++lastDocumentId,
      ...fields,
      role: null,
      side: null,
      roleConfirmed: false,
      polls: 0,
      ocrApplied: false,
      createdAt: now,
      updatedAt: now,
    };
    state.documents.set(document.id, document);
    return document;
  }

  // ---------- The server ----------

  const server = createServer((req, res) => {
    void receive(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    state,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

// ---------- The main app's answer shapes ----------

/** A document row of the matter detail: no pages, no text, no blob URL, no hash. */
function summary(document: FakeDocument) {
  const { id, filename, role, side, roleConfirmed, origin, ingestStatus, ocrApplied, sizeBytes, createdAt } = document;
  return {
    id,
    filename,
    role,
    side,
    roleConfirmed,
    guide: null,
    origin,
    ingestStatus,
    pageCount: document.pages.length,
    ocrApplied,
    sizeBytes,
    createdAt,
  };
}

/** The row a create or a patch answers with (MATTER_DOCUMENT_CURATED_FIELDS). */
function curated(document: FakeDocument) {
  const { id, matterId, filename, mimeType, sizeBytes, role, side, roleConfirmed, origin, ingestStatus, ocrApplied } = document;
  const pageCount = document.pages.length;
  return {
    id,
    matterId,
    filename,
    mimeType,
    sizeBytes,
    role,
    side,
    roleConfirmed,
    guide: null,
    origin,
    ingestStatus,
    ingestError: null,
    ocrApplied,
    pageCount,
    createdAt: document.createdAt,
  };
}

/** GET …/documents/{docId}: the pages' OCR progress, and their text once the document is ready. */
function detail(document: FakeDocument) {
  const { id, filename, mimeType, sizeBytes, role, side, roleConfirmed, origin, ingestStatus, ocrApplied } = document;
  const ready = ingestStatus === "ready";
  const pages = document.pages.map(({ page, text, needsOcr }) => ({
    page,
    needsOcr,
    ocrDone: ready && needsOcr,
    confidence: null,
    ...(ready ? { text } : {}),
  }));
  return {
    id,
    filename,
    mimeType,
    sizeBytes,
    role,
    side,
    roleConfirmed,
    guide: null,
    origin,
    ingestStatus,
    ingestError: null,
    pageCount: pages.length,
    ocrApplied,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    pages,
    extractedText: ready ? "" : null,
  };
}

// ---------- Checks ----------

/** lib/matters.ts matterBlobPrefix: where all of a matter's blobs live. */
function blobPrefix(matter: FakeMatter): string {
  return `matters/u${matter.userId}/m${matter.id}/`;
}

/** lib/matter-blob.ts isPathnameUnderPrefix: under the prefix, a non-empty key, no empty, "." or ".." segment. */
function isPlainKeyUnder(pathname: string, prefix: string): boolean {
  if (!pathname.startsWith(prefix)) return false;
  const key = pathname.slice(prefix.length);
  return key !== "" && !key.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

/** lib/matter-blob.ts isOwnBlobUrl: an https URL on the store's private host whose decoded path lies under the prefix. */
function isOwnBlobUrl(url: string, prefix: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== STORE_HOST) return false;
    return isPlainKeyUnder(decodeURIComponent(parsed.pathname).slice(1), prefix);
  } catch {
    return false;
  }
}

/** lib/matter-blob.ts sniffFileKind: the magic bytes, never the extension or the claimed type. */
function sniffFileKind(head: Buffer): "pdf" | "docx" | null {
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return "docx";
  return null;
}

/** lib/matters.ts textDocumentMime: the type a text document's extension gives it. */
function textDocumentMime(filename: string): string | null {
  if (/\.txt$/i.test(filename)) return "text/plain";
  if (/\.md$/i.test(filename)) return "text/markdown";
  return null;
}

// ---------- Helpers ----------

function ok(body: unknown): Answer {
  return { status: 200, body };
}

function refuse(status: number, error: string): Answer {
  return { status, body: { error } };
}

/** A string field trimmed and cut at `max`; "" when it is not a string. */
function trimmed(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The body parsed as JSON; undefined when it is not JSON. */
function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(", ") : value;
}
