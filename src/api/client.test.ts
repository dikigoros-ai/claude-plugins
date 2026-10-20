import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../auth/device-flow";
import {
  type CreateMatterDocumentInput,
  DikigorosApi,
  type IngestManifest,
  type Matter,
  type MatterDetail,
  type MatterDocumentDetail,
  type MatterDocumentRecord,
  type MatterDocumentSummary,
  type MatterSummary,
  type ProcessResult,
} from "./client";
import { ApiError } from "./errors";

const BASE = "https://dikigoros.ai";
const TOKEN = "at-secret-1";
const FRESH_TOKEN = "at-secret-2";

/** The headers of a request without a body, names lower-cased; one with a JSON body adds its type. */
const HEADERS = { accept: "application/json", authorization: `Bearer ${TOKEN}` };
const JSON_HEADERS = { ...HEADERS, "content-type": "application/json" };

// The answers below are the ones the DIKIGOROS routes send, every field they send.

/** GET /auth/current-user: lib/auth.ts buildUserResponse, of which CurrentUser is a part. */
const USER = {
  id: 42,
  email: "lawyer@example.com",
  name: "Eleni Georgiou",
  role: "user",
  plan: "firm",
  createdAt: "2026-03-02T10:15:00.000Z",
  languagePreference: "el",
  entitlements: { mattersAccess: true, activeMatters: 10, docsPerMatter: 50, weeklyTokens: 3_800_000, tier: "firm" },
};

const MATTER: Matter = {
  id: 7,
  userId: 42,
  title: "Γεωργίου v. Πέτρου",
  caseReference: "Αγωγή 1234/2026",
  matterType: "civil",
  description: "Breach of a commercial lease.",
  status: "active",
  deletedAt: null,
  createdAt: "2026-10-01T09:00:00.000Z",
  updatedAt: "2026-10-18T16:30:00.000Z",
};

const MATTER_SUMMARY: MatterSummary = {
  id: 7,
  title: "Γεωργίου v. Πέτρου",
  caseReference: "Αγωγή 1234/2026",
  matterType: "civil",
  status: "active",
  updatedAt: "2026-10-18T16:30:00.000Z",
  documentCount: 1,
};

const DOCUMENT_SUMMARY: MatterDocumentSummary = {
  id: 30,
  filename: "lease.pdf",
  role: "exhibit",
  side: "ours",
  roleConfirmed: true,
  guide: "The lease of 2021 between the parties.",
  origin: "upload",
  ingestStatus: "ready",
  pageCount: 12,
  ocrApplied: false,
  sizeBytes: 482_113,
  createdAt: "2026-10-02T08:00:00.000Z",
};

const MATTER_DETAIL: MatterDetail = { matter: MATTER, documents: [DOCUMENT_SUMMARY], pins: [], notes: [], artifacts: [] };

const CREATE_DOCUMENT: CreateMatterDocumentInput = {
  filename: "claim.pdf",
  mimeType: "application/pdf",
  sizeBytes: 48_213,
  sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  blobUrl: "https://teststore.private.blob.vercel-storage.com/matters/u42/m7/claim-x1Yz.pdf",
  headBytesBase64: "JVBERi0xLjc=",
};

const DOCUMENT_RECORD: MatterDocumentRecord = {
  id: 31,
  matterId: 7,
  filename: "claim.pdf",
  mimeType: "application/pdf",
  sizeBytes: 48_213,
  role: null,
  side: null,
  roleConfirmed: false,
  guide: null,
  origin: null,
  ingestStatus: "pending",
  ingestError: null,
  ocrApplied: false,
  pageCount: 0,
  createdAt: "2026-10-19T10:00:00.000Z",
};

const PATCHED_RECORD: MatterDocumentRecord = { ...DOCUMENT_RECORD, role: "exhibit", side: null, roleConfirmed: true };

const TEXT_RECORD: MatterDocumentRecord = {
  ...DOCUMENT_RECORD,
  id: 32,
  filename: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 64,
  origin: "text",
  ingestStatus: "processing",
  pageCount: 1,
};

const MANIFEST: IngestManifest = {
  kind: "pdf",
  pages: [
    { page: 1, text: "ΕΝΩΠΙΟΝ ΤΟΥ ΕΠΑΡΧΙΑΚΟΥ ΔΙΚΑΣΤΗΡΙΟΥ ΛΕΜΕΣΟΥ", needsOcr: false },
    {
      page: 2,
      text: "",
      needsOcr: true,
      imageBlobKey: "https://teststore.private.blob.vercel-storage.com/matters/u42/m7/pages/p2-x9Q.jpg",
    },
  ],
};

const PROCESS_READY: ProcessResult = {
  status: "ready",
  ocrRemaining: 0,
  suggested: true,
  document: {
    id: 31,
    filename: "claim.pdf",
    role: "statement_of_claim",
    side: "theirs",
    roleConfirmed: false,
    ingestStatus: "ready",
    pageCount: 2,
    ocrApplied: true,
    extractedText: "ΕΝΩΠΙΟΝ ΤΟΥ ΕΠΑΡΧΙΑΚΟΥ ΔΙΚΑΣΤΗΡΙΟΥ ΛΕΜΕΣΟΥ\n\nΑγωγή αρ. 1234/2026",
  },
};

const DOCUMENT_DETAIL: MatterDocumentDetail = {
  id: 31,
  filename: "claim.pdf",
  mimeType: "application/pdf",
  sizeBytes: 48_213,
  role: "statement_of_claim",
  side: "theirs",
  roleConfirmed: false,
  guide: null,
  origin: null,
  ingestStatus: "processing",
  ingestError: null,
  pageCount: 2,
  ocrApplied: false,
  createdAt: "2026-10-19T10:00:00.000Z",
  updatedAt: "2026-10-19T10:00:05.000Z",
  pages: [
    { page: 1, needsOcr: false, ocrDone: false, confidence: null },
    { page: 2, needsOcr: true, ocrDone: false, confidence: null },
  ],
  extractedText: null,
};

/** A blob pathname as the pipeline builds it: the matter prefix and the file's own name, verbatim. */
const PATHNAME = "matters/u42/m7/Αγωγή αρ. 5.pdf";
const CLIENT_TOKEN = "vercel_blob_client_teststore_ct-secret";
const CLIENT_TOKEN_ANSWER = { type: "blob.generate-client-token", clientToken: CLIENT_TOKEN };

const AUTHENTICATION_REQUIRED = { error: "Authentication required" };

type Answer = () => Promise<Response>;

function json(status: number, body: unknown): Answer {
  return async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function text(status: number, body: string, contentType = "text/html; charset=utf-8"): Answer {
  return async () => new Response(body, { status, headers: { "Content-Type": contentType } });
}

interface RecordedRequest {
  method: string | undefined;
  url: string;
  headers: Record<string, string>;
  /** The JSON body, parsed; undefined when the request had none. */
  body: unknown;
  redirect: RequestRedirect | undefined;
}

/** The request's headers, names lower-cased. */
function headerRecord(init: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  new Headers(init).forEach((value, name) => {
    record[name] = value;
  });
  return record;
}

/** A fetch that records each request (its JSON body parsed) and gives the next canned answer. */
function recordingFetch(...answers: Answer[]): { fetchImpl: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl: FetchLike = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      method: init?.method,
      url: String(input),
      headers: headerRecord(init?.headers),
      body: init?.body === undefined || init.body === null ? undefined : JSON.parse(String(init.body)),
      redirect: init?.redirect,
    });
    const next = answers.shift();
    if (next === undefined) throw new Error(`no answer left for request ${requests.length} (${String(input)})`);
    return next();
  };
  return { fetchImpl, requests };
}

interface Session {
  getToken?: () => Promise<string | null>;
  onUnauthorized?: () => Promise<string | null>;
}

/** A client on BASE whose session hands out TOKEN, and FRESH_TOKEN after a 401, unless told otherwise. */
function apiWith(fetchImpl: FetchLike, session: Session = {}) {
  const getToken = vi.fn<() => Promise<string | null>>(session.getToken ?? (async () => TOKEN));
  const onUnauthorized = vi.fn<() => Promise<string | null>>(session.onUnauthorized ?? (async () => FRESH_TOKEN));
  return { api: new DikigorosApi({ baseUrl: BASE, getToken, onUnauthorized, fetchImpl }), getToken, onUnauthorized };
}

/** The ApiError `promise` rejects with; fails the test when it resolves or rejects otherwise. */
async function refused(promise: Promise<unknown>): Promise<ApiError> {
  const err = await promise.then(
    () => {
      throw new Error("expected an ApiError, the call succeeded");
    },
    (reason: unknown) => reason,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

/** What a test checks of an ApiError: everything it carries. */
function shown(err: ApiError): { status: number; code: string; metadata: Record<string, unknown>; message: string } {
  return { status: err.status, code: err.code, metadata: err.metadata, message: err.message };
}

describe("DikigorosApi routes", () => {
  // A loop rather than it.each, which would cut the titles at 40 characters.
  for (const { title, call, answer, request, result } of [
    {
      title: "currentUser GETs /auth/current-user and returns the user",
      call: (api: DikigorosApi) => api.currentUser(),
      answer: json(200, USER),
      request: { method: "GET", url: `${BASE}/auth/current-user`, headers: HEADERS, body: undefined, redirect: "error" },
      result: USER,
    },
    {
      title: "listMatters GETs /api/matters and returns its matters",
      call: (api: DikigorosApi) => api.listMatters(),
      answer: json(200, { matters: [MATTER_SUMMARY] }),
      request: { method: "GET", url: `${BASE}/api/matters`, headers: HEADERS, body: undefined, redirect: "error" },
      result: [MATTER_SUMMARY],
    },
    {
      title: "createMatter POSTs the matter to /api/matters and returns the 201's matter",
      call: (api: DikigorosApi) =>
        api.createMatter({
          title: "Γεωργίου v. Πέτρου",
          caseReference: "Αγωγή 1234/2026",
          matterType: "civil",
          description: "Breach of a commercial lease.",
        }),
      answer: json(201, { matter: MATTER }),
      request: {
        method: "POST",
        url: `${BASE}/api/matters`,
        headers: JSON_HEADERS,
        body: {
          title: "Γεωργίου v. Πέτρου",
          caseReference: "Αγωγή 1234/2026",
          matterType: "civil",
          description: "Breach of a commercial lease.",
        },
        redirect: "error",
      },
      result: MATTER,
    },
    {
      title: "getMatter GETs /api/matters/{id} and returns the whole answer",
      call: (api: DikigorosApi) => api.getMatter(7),
      answer: json(200, MATTER_DETAIL),
      request: { method: "GET", url: `${BASE}/api/matters/7`, headers: HEADERS, body: undefined, redirect: "error" },
      result: MATTER_DETAIL,
    },
    {
      title: "createDocument POSTs the uploaded blob's record to …/documents and returns the 201's document",
      call: (api: DikigorosApi) => api.createDocument(7, CREATE_DOCUMENT),
      answer: json(201, { document: DOCUMENT_RECORD }),
      request: {
        method: "POST",
        url: `${BASE}/api/matters/7/documents`,
        headers: JSON_HEADERS,
        body: CREATE_DOCUMENT,
        redirect: "error",
      },
      result: DOCUMENT_RECORD,
    },
    {
      title: "patchDocument PATCHes role and side (null kept) to …/documents/{docId} and returns its document",
      call: (api: DikigorosApi) => api.patchDocument(7, 31, { role: "exhibit", side: null }),
      answer: json(200, { document: PATCHED_RECORD }),
      request: {
        method: "PATCH",
        url: `${BASE}/api/matters/7/documents/31`,
        headers: JSON_HEADERS,
        body: { role: "exhibit", side: null },
        redirect: "error",
      },
      result: PATCHED_RECORD,
    },
    {
      title: "createTextDocument POSTs filename and text to …/documents/text and returns the 201's document",
      call: (api: DikigorosApi) => api.createTextDocument(7, { filename: "notes.txt", text: "Σημειώσεις συνάντησης\nμε τον πελάτη" }),
      answer: json(201, { document: TEXT_RECORD }),
      request: {
        method: "POST",
        url: `${BASE}/api/matters/7/documents/text`,
        headers: JSON_HEADERS,
        body: { filename: "notes.txt", text: "Σημειώσεις συνάντησης\nμε τον πελάτη" },
        redirect: "error",
      },
      result: TEXT_RECORD,
    },
    {
      title: "ingest POSTs the manifest to …/documents/{docId}/ingest and returns ocrPages",
      call: (api: DikigorosApi) => api.ingest(7, 31, MANIFEST),
      answer: json(200, { ocrPages: 1 }),
      request: {
        method: "POST",
        url: `${BASE}/api/matters/7/documents/31/ingest`,
        headers: JSON_HEADERS,
        body: MANIFEST,
        redirect: "error",
      },
      result: { ocrPages: 1 },
    },
    {
      title: "process POSTs without a body to …/documents/{docId}/process and returns the whole answer",
      call: (api: DikigorosApi) => api.process(7, 31),
      answer: json(200, PROCESS_READY),
      request: {
        method: "POST",
        url: `${BASE}/api/matters/7/documents/31/process`,
        headers: HEADERS,
        body: undefined,
        redirect: "error",
      },
      result: PROCESS_READY,
    },
    {
      title: "getDocument GETs …/documents/{docId} and returns its document",
      call: (api: DikigorosApi) => api.getDocument(7, 31),
      answer: json(200, { document: DOCUMENT_DETAIL }),
      request: {
        method: "GET",
        url: `${BASE}/api/matters/7/documents/31`,
        headers: HEADERS,
        body: undefined,
        redirect: "error",
      },
      result: DOCUMENT_DETAIL,
    },
    {
      title: "requestUploadToken POSTs the blob.generate-client-token event to …/documents/upload and returns the clientToken",
      call: (api: DikigorosApi) => api.requestUploadToken(7, PATHNAME),
      answer: json(200, CLIENT_TOKEN_ANSWER),
      request: {
        method: "POST",
        url: `${BASE}/api/matters/7/documents/upload`,
        headers: JSON_HEADERS,
        body: { type: "blob.generate-client-token", payload: { pathname: PATHNAME, clientPayload: null, multipart: false } },
        redirect: "error",
      },
      result: CLIENT_TOKEN,
    },
  ]) {
    it(title, async () => {
      const { fetchImpl, requests } = recordingFetch(answer);
      const { api, getToken, onUnauthorized } = apiWith(fetchImpl);
      expect(await call(api)).toEqual(result);
      expect(requests).toEqual([request]);
      expect(getToken).toHaveBeenCalledTimes(1);
      expect(onUnauthorized).not.toHaveBeenCalled();
    });
  }

  it("sends every request to the base URL it was given", async () => {
    const { fetchImpl, requests } = recordingFetch(json(200, { matters: [] }));
    const api = new DikigorosApi({
      baseUrl: "http://localhost:3000",
      getToken: async () => TOKEN,
      onUnauthorized: async () => FRESH_TOKEN,
      fetchImpl,
    });
    expect(await api.listMatters()).toEqual([]);
    expect(requests.map((request) => request.url)).toEqual(["http://localhost:3000/api/matters"]);
  });
});

describe("a refusal", () => {
  it("429 document_limit_reached becomes ApiError(429, document_limit_reached, { limit: 50 }) with no retry", async () => {
    const { fetchImpl, requests } = recordingFetch(json(429, { error: "document_limit_reached", limit: 50 }));
    const { api, onUnauthorized } = apiWith(fetchImpl);
    const err = await refused(api.createDocument(7, CREATE_DOCUMENT));
    expect(shown(err)).toEqual({
      status: 429,
      code: "document_limit_reached",
      metadata: { limit: 50 },
      message: "429 document_limit_reached",
    });
    expect(requests).toHaveLength(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("keeps the rest of the error body as metadata, less error and message", async () => {
    const { fetchImpl } = recordingFetch(
      json(403, {
        error: "email_not_verified",
        message: "Please verify your email address to continue.",
        email: "lawyer@example.com",
      }),
    );
    const err = await refused(apiWith(fetchImpl).api.currentUser());
    expect(shown(err)).toEqual({
      status: 403,
      code: "email_not_verified",
      metadata: { email: "lawyer@example.com" },
      message: "403 email_not_verified",
    });
  });

  it("keeps an error string that is a sentence as the code", async () => {
    const { fetchImpl } = recordingFetch(
      json(429, { error: "Weekly usage limit reached", limit: 3_800_000, used: 3_800_412, remaining: 0, plan: "firm" }),
    );
    const err = await refused(apiWith(fetchImpl).api.ingest(7, 31, MANIFEST));
    expect(shown(err)).toEqual({
      status: 429,
      code: "Weekly usage limit reached",
      metadata: { limit: 3_800_000, used: 3_800_412, remaining: 0, plan: "firm" },
      message: "429 Weekly usage limit reached",
    });
  });

  it.each([
    {
      what: "a page that is not JSON",
      answer: text(502, "<html><body>Bad gateway</body></html>"),
      status: 502,
      metadata: {},
    },
    {
      what: "a body without an error",
      answer: json(500, { message: "Internal error", detail: "x" }),
      status: 500,
      metadata: { detail: "x" },
    },
    { what: "an empty error", answer: json(400, { error: "" }), status: 400, metadata: {} },
    { what: "an error that is not a string", answer: json(400, { error: { reason: "x" } }), status: 400, metadata: {} },
    { what: "a JSON body that is not an object", answer: json(400, ["Invalid"]), status: 400, metadata: {} },
    { what: "no body at all", answer: async () => new Response(null, { status: 503 }), status: 503, metadata: {} },
  ])("with $what is coded http_<status>", async ({ answer, status, metadata }) => {
    const { fetchImpl } = recordingFetch(answer);
    const err = await refused(apiWith(fetchImpl).api.listMatters());
    expect(shown(err)).toEqual({ status, code: `http_${status}`, metadata, message: `${status} http_${status}` });
  });
});

describe("a success answer the route does not send", () => {
  it.each([
    {
      what: "listMatters: a page that is not JSON",
      call: (api: DikigorosApi) => api.listMatters(),
      answer: text(200, "<!DOCTYPE html><title>DIKIGOROS</title>"),
      status: 200,
    },
    {
      what: "listMatters: no matters",
      call: (api: DikigorosApi) => api.listMatters(),
      answer: json(200, {}),
      status: 200,
    },
    {
      what: "getMatter: a JSON array",
      call: (api: DikigorosApi) => api.getMatter(7),
      answer: json(200, [MATTER]),
      status: 200,
    },
    {
      what: "createDocument: no document",
      call: (api: DikigorosApi) => api.createDocument(7, CREATE_DOCUMENT),
      answer: json(201, { matter: MATTER }),
      status: 201,
    },
    {
      what: "ingest: ocrPages a string",
      call: (api: DikigorosApi) => api.ingest(7, 31, MANIFEST),
      answer: json(200, { ocrPages: "1" }),
      status: 200,
    },
    {
      what: "requestUploadToken: no clientToken",
      call: (api: DikigorosApi) => api.requestUploadToken(7, PATHNAME),
      answer: json(200, { type: "blob.generate-client-token" }),
      status: 200,
    },
    {
      what: "requestUploadToken: empty clientToken",
      call: (api: DikigorosApi) => api.requestUploadToken(7, PATHNAME),
      answer: json(200, { type: "blob.generate-client-token", clientToken: "" }),
      status: 200,
    },
  ])("$what → ApiError(<status>, invalid_response)", async ({ call, answer, status }) => {
    const { fetchImpl } = recordingFetch(answer);
    const err = await refused(call(apiWith(fetchImpl).api));
    expect(shown(err)).toEqual({ status, code: "invalid_response", metadata: {}, message: `${status} invalid_response` });
  });
});

describe("the bearer and the 401 retry", () => {
  it("throws ApiError(401, not_signed_in) without a request when there is no token", async () => {
    const { fetchImpl, requests } = recordingFetch();
    const { api, onUnauthorized } = apiWith(fetchImpl, { getToken: async () => null });
    const err = await refused(api.listMatters());
    expect(shown(err)).toEqual({ status: 401, code: "not_signed_in", metadata: {}, message: "401 not_signed_in" });
    expect(requests).toEqual([]);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("retries once after a 401, with the token onUnauthorized returns, and the same request", async () => {
    const { fetchImpl, requests } = recordingFetch(json(401, AUTHENTICATION_REQUIRED), json(200, CLIENT_TOKEN_ANSWER));
    const { api, getToken, onUnauthorized } = apiWith(fetchImpl);
    expect(await api.requestUploadToken(7, PATHNAME)).toBe(CLIENT_TOKEN);
    const sent = {
      method: "POST",
      url: `${BASE}/api/matters/7/documents/upload`,
      body: { type: "blob.generate-client-token", payload: { pathname: PATHNAME, clientPayload: null, multipart: false } },
      redirect: "error",
    };
    expect(requests).toEqual([
      { ...sent, headers: JSON_HEADERS },
      { ...sent, headers: { ...JSON_HEADERS, authorization: `Bearer ${FRESH_TOKEN}` } },
    ]);
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("throws the 401 without a second request when onUnauthorized has no token", async () => {
    const { fetchImpl, requests } = recordingFetch(json(401, AUTHENTICATION_REQUIRED));
    const { api, onUnauthorized } = apiWith(fetchImpl, { onUnauthorized: async () => null });
    const err = await refused(api.getMatter(7));
    expect(shown(err)).toEqual({
      status: 401,
      code: "Authentication required",
      metadata: {},
      message: "401 Authentication required",
    });
    expect(requests).toHaveLength(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("throws the second 401, having asked onUnauthorized once", async () => {
    const { fetchImpl, requests } = recordingFetch(json(401, AUTHENTICATION_REQUIRED), json(401, AUTHENTICATION_REQUIRED));
    const { api, onUnauthorized } = apiWith(fetchImpl);
    const err = await refused(api.process(7, 31));
    expect(shown(err)).toEqual({
      status: 401,
      code: "Authentication required",
      metadata: {},
      message: "401 Authentication required",
    });
    expect(requests.map((request) => request.headers.authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${FRESH_TOKEN}`]);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("throws a 401 connector_token_not_accepted at once: a fresh token would not pass a route outside the allowlist", async () => {
    const { fetchImpl, requests } = recordingFetch(json(401, { error: "connector_token_not_accepted" }));
    const { api, onUnauthorized } = apiWith(fetchImpl);
    const err = await refused(api.createTextDocument(7, { filename: "notes.txt", text: "Σημειώσεις" }));
    expect(shown(err)).toEqual({
      status: 401,
      code: "connector_token_not_accepted",
      metadata: {},
      message: "401 connector_token_not_accepted",
    });
    expect(requests).toHaveLength(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("throws what the retry answers when it is another refusal", async () => {
    const { fetchImpl, requests } = recordingFetch(
      json(401, AUTHENTICATION_REQUIRED),
      json(403, { error: "entitlement_required", entitlement: "mattersAccess", requiredPlan: "firm" }),
    );
    const err = await refused(apiWith(fetchImpl).api.listMatters());
    expect(shown(err)).toEqual({
      status: 403,
      code: "entitlement_required",
      metadata: { entitlement: "mattersAccess", requiredPlan: "firm" },
      message: "403 entitlement_required",
    });
    expect(requests).toHaveLength(2);
  });

  it("lets a failure to get the token through as it is, without a request", async () => {
    const outage = new TypeError("fetch failed");
    const { fetchImpl, requests } = recordingFetch();
    const { api } = apiWith(fetchImpl, { getToken: () => Promise.reject(outage) });
    await expect(api.listMatters()).rejects.toBe(outage);
    expect(requests).toEqual([]);
  });

  it("lets a failure to get a fresh token through as it is: an outage is not a sign-out", async () => {
    const outage = new TypeError("fetch failed");
    const { fetchImpl, requests } = recordingFetch(json(401, AUTHENTICATION_REQUIRED));
    const { api } = apiWith(fetchImpl, { onUnauthorized: () => Promise.reject(outage) });
    await expect(api.process(7, 31)).rejects.toBe(outage);
    expect(requests).toHaveLength(1);
  });

  it("lets a request that got no answer through as it is", async () => {
    const noAnswer = new TypeError("fetch failed");
    const { api } = apiWith(async () => Promise.reject(noAnswer));
    await expect(api.currentUser()).rejects.toBe(noAnswer);
  });

  it("lets an answer whose body was cut off through as it is, not as an invalid response", async () => {
    const cutOff = new TypeError("terminated");
    const body = new ReadableStream({
      start(controller) {
        controller.error(cutOff);
      },
    });
    const { fetchImpl } = recordingFetch(async () => new Response(body, { status: 200 }));
    await expect(apiWith(fetchImpl).api.listMatters()).rejects.toBe(cutOff);
  });
});

describe("what an ApiError carries", () => {
  it("never the token, the request body or an answer that is not JSON", async () => {
    const upstream = "<html><body>upstream-secret-7f3a</body></html>";
    const { fetchImpl } = recordingFetch(text(401, upstream), text(401, upstream));
    const err = await refused(
      apiWith(fetchImpl).api.createTextDocument(7, { filename: "notes.txt", text: "client-secret-text-91c2" }),
    );
    expect(shown(err)).toEqual({ status: 401, code: "http_401", metadata: {}, message: "401 http_401" });
    const everything = inspect(err, { depth: null, showHidden: true });
    for (const secret of [TOKEN, FRESH_TOKEN, "client-secret-text-91c2", "upstream-secret-7f3a"]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("never a success answer it could not read", async () => {
    // Not JSON: JSON.parse's SyntaxError quotes its first ten characters.
    const { fetchImpl } = recordingFetch(text(200, CLIENT_TOKEN, "text/plain"));
    const err = await refused(apiWith(fetchImpl).api.requestUploadToken(7, PATHNAME));
    expect(shown(err)).toEqual({ status: 200, code: "invalid_response", metadata: {}, message: "200 invalid_response" });
    expect(inspect(err, { depth: null, showHidden: true })).not.toContain(CLIENT_TOKEN.slice(0, 10));
  });
});
