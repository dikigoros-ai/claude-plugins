// The typed client for the DIKIGOROS REST routes the web uploader uses, authenticated with the
// session's Auth0 access token. Every request carries the bearer and is sent only to the base URL;
// a 401 is answered once with a fresh token. A refusal becomes an ApiError (./errors), which never
// holds a token, a request body or an answer that was not JSON.
//
// The response shapes are copied from the main app, dikigoros-ai/dikigoros-ai @ 37f39ac5
// (2026-10-19): lib/api.ts (the Matters types), lib/matters.ts (the unions), lib/i18n.ts
// (Language), and checked against the routes under app/api/matters/ and app/auth/current-user/.
// Nothing is imported from that repository.

import type { FetchLike } from "../auth/device-flow";
import { ApiError } from "./errors";

// ---------- Shapes (lib/matters.ts, lib/i18n.ts, lib/api.ts @ 37f39ac5) ----------

export type MatterType = "civil" | "criminal" | "interim_application" | "appeal" | "other";

export type MatterDocumentRole =
  | "statement_of_claim"
  | "defense"
  | "reply"
  | "affidavit"
  | "opposition"
  | "witness_statement"
  | "exhibit"
  | "interim_application"
  | "court_order"
  | "correspondence"
  | "other"
  | "written_submission"
  | "judgment"
  | "expert_report"
  | "minutes"
  | "notice"
  | "bundle"
  // Written by the server alone, for a verified artifact saved as a document; a client never sends it.
  | "generated";

export type MatterSide = "ours" | "theirs" | "neutral";

export type IngestStatus = "pending" | "processing" | "ready" | "failed";

/** Where a document came from; an `origin` of null is a row from before the column existed, an upload. */
export type DocumentOrigin = "upload" | "generated" | "text";

export type ArtifactKind = "answer" | "summary" | "chronology";

export type ArtifactStatus = "generating" | "draft" | "verified";

export type Language = "en" | "el";

export interface Matter {
  id: number;
  userId: number;
  title: string;
  caseReference: string;
  matterType: MatterType | null;
  description: string;
  status: "active" | "archived";
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A row of `GET /api/matters`: no description, userId or deletedAt. */
export interface MatterSummary {
  id: number;
  title: string;
  caseReference: string;
  matterType: MatterType | null;
  status: "active" | "archived";
  updatedAt: string;
  documentCount: number;
}

/**
 * The body of `POST /api/matters`. lib/api.ts types `matterType` as MatterType; the route trims and
 * caps the strings and stores a `matterType` outside MatterType as none, so any string is taken here.
 */
export interface CreateMatterInput {
  title: string;
  caseReference?: string;
  matterType?: string;
  description?: string;
}

/** A document row of the matter detail and the documents list: no pages or extracted text. */
export interface MatterDocumentSummary {
  id: number;
  filename: string;
  role: MatterDocumentRole | null;
  side: MatterSide | null;
  roleConfirmed: boolean;
  /** The two-sentence source guide, written after the first OCR batch; null until then. */
  guide: string | null;
  origin: DocumentOrigin | null;
  ingestStatus: IngestStatus;
  pageCount: number;
  ocrApplied: boolean;
  sizeBytes: number;
  createdAt: string;
}

export interface MatterPin {
  id: number;
  matterId: number;
  userId: number;
  kind: "case" | "provision" | "statute";
  ref: string;
  label: string;
  createdAt: string;
}

export interface MatterNote {
  id: number;
  matterId: number;
  userId: number;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface MatterArtifactSummary {
  id: number;
  matterId: number;
  kind: ArtifactKind;
  title: string;
  status: ArtifactStatus;
  language: Language;
  sourceSessionId: string | null;
  sourceMessageId: string | null;
  generatedDocumentId: number | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/matters/{id}`. */
export interface MatterDetail {
  matter: Matter;
  documents: MatterDocumentSummary[];
  pins: MatterPin[];
  notes: MatterNote[];
  artifacts: MatterArtifactSummary[];
}

/** The document row a create or a patch returns: never the blob URL, the hash, the pages or the text. */
export interface MatterDocumentRecord {
  id: number;
  matterId: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  role: MatterDocumentRole | null;
  side: MatterSide | null;
  roleConfirmed: boolean;
  guide: string | null;
  origin: DocumentOrigin | null;
  ingestStatus: IngestStatus;
  ingestError: string | null;
  ocrApplied: boolean;
  pageCount: number;
  createdAt: string;
}

/**
 * The body of `POST …/documents`, registering a blob already uploaded to the store. `blobUrl`
 * must lie under the caller's own matter prefix; `headBytesBase64` is the sample the server sniffs
 * for the real file kind (the claimed `mimeType` is never trusted).
 */
export interface CreateMatterDocumentInput {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  blobUrl: string;
  headBytesBase64: string;
}

/** A page's OCR progress; `text` only once the document is ready. */
export interface MatterDocumentPageMeta {
  page: number;
  needsOcr: boolean;
  ocrDone: boolean;
  confidence: number | null;
  text?: string;
}

/**
 * `GET …/documents/{docId}`. Once ready, each page carries its own text and `extractedText` is "";
 * before that the pages carry OCR progress only and `extractedText` is null.
 */
export interface MatterDocumentDetail {
  id: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  role: MatterDocumentRole | null;
  side: MatterSide | null;
  roleConfirmed: boolean;
  guide: string | null;
  origin: DocumentOrigin | null;
  ingestStatus: IngestStatus;
  ingestError: string | null;
  pageCount: number;
  ocrApplied: boolean;
  createdAt: string;
  updatedAt: string;
  pages: MatterDocumentPageMeta[];
  extractedText: string | null;
}

/** The body of `POST …/documents/{docId}/ingest`: a PDF's pages, or a DOCX's whole text. */
export type IngestManifest =
  | {
      kind: "pdf";
      pages: Array<{ page: number; text: string; needsOcr: boolean; imageBlobKey?: string }>;
    }
  | { kind: "docx"; fullText: string };

/** `POST …/documents/{docId}/process`: one batch of the server's processing. */
export interface ProcessResult {
  status: IngestStatus;
  ocrRemaining: number;
  /** The role and guide suggestion landed on this poll. */
  suggested?: boolean;
  /** On some failed results, why (`no_text_extracted`); absent for the generic failure. */
  errorCode?: string;
  /** Only when the status is ready: the finished document row. */
  document?: {
    id: number;
    filename: string;
    role: MatterDocumentRole | null;
    side: MatterSide | null;
    roleConfirmed: boolean;
    ingestStatus: IngestStatus;
    pageCount: number;
    ocrApplied: boolean;
    extractedText: string;
  };
}

// ---------- The client ----------

/** The part of `GET /auth/current-user` (lib/auth.ts buildUserResponse) the helper reads; the answer holds more. */
export interface CurrentUser {
  id: number;
  email: string;
  plan: string;
  entitlements: { mattersAccess: boolean; docsPerMatter: number; activeMatters: number; tier: string };
}

export interface ApiDeps {
  /** The origin every request goes to, without a trailing slash: `${baseUrl}${path}`. */
  baseUrl: string;
  /** The access token to send; null when nobody is signed in. */
  getToken: () => Promise<string | null>;
  /** Called once after a 401: drops the refused token and answers a fresh one, or null when there is none. */
  onUnauthorized: () => Promise<string | null>;
  fetchImpl: FetchLike;
}

type Method = "GET" | "POST" | "PATCH";

/** An answer from the API: its status, and its body parsed as JSON (undefined when it is not JSON). */
interface Answer {
  ok: boolean;
  status: number;
  body: unknown;
}

/**
 * The DIKIGOROS routes the upload uses. Ids are integers the caller has validated. Each method
 * returns what the route answers, unwrapped from its envelope (`{ matters }`, `{ matter }`,
 * `{ document }`); the envelope is checked, the fields inside it are trusted to be the shapes
 * above. Every refusal, and a success answer the route does not send, throws an ApiError.
 */
export class DikigorosApi {
  readonly #deps: ApiDeps;

  constructor(deps: ApiDeps) {
    this.#deps = deps;
  }

  /** `GET /auth/current-user`: who is signed in, and what the plan allows. */
  async currentUser(): Promise<CurrentUser> {
    return object<CurrentUser>(await this.#request("GET", "/auth/current-user"));
  }

  /** `GET /api/matters`: the lawyer's matters, the most recently updated first. */
  async listMatters(): Promise<MatterSummary[]> {
    return member<MatterSummary[]>(await this.#request("GET", "/api/matters"), "matters", Array.isArray);
  }

  /** `POST /api/matters` → 201 `{ matter }`. */
  async createMatter(input: CreateMatterInput): Promise<Matter> {
    return member<Matter>(await this.#request("POST", "/api/matters", input), "matter", isRecord);
  }

  /** `GET /api/matters/{id}`: the matter with its documents, pins, notes and artifacts. */
  async getMatter(id: number): Promise<MatterDetail> {
    return object<MatterDetail>(await this.#request("GET", `/api/matters/${id}`));
  }

  /** `POST /api/matters/{id}/documents` → 201 `{ document }`, registering an uploaded blob. */
  async createDocument(matterId: number, input: CreateMatterDocumentInput): Promise<MatterDocumentRecord> {
    const answer = await this.#request("POST", documentsPath(matterId), input);
    return member<MatterDocumentRecord>(answer, "document", isRecord);
  }

  /** `PATCH …/documents/{docId}` → `{ document }`: sets the role and the side (null clears it). */
  async patchDocument(
    matterId: number,
    docId: number,
    input: { role?: string; side?: string | null },
  ): Promise<MatterDocumentRecord> {
    const answer = await this.#request("PATCH", `${documentsPath(matterId)}/${docId}`, input);
    return member<MatterDocumentRecord>(answer, "document", isRecord);
  }

  /** `POST …/documents/text` → 201 `{ document }`: a .txt or .md document from its text, without a blob. */
  async createTextDocument(matterId: number, input: { filename: string; text: string }): Promise<MatterDocumentRecord> {
    const answer = await this.#request("POST", `${documentsPath(matterId)}/text`, input);
    return member<MatterDocumentRecord>(answer, "document", isRecord);
  }

  /** `POST …/documents/{docId}/ingest` → `{ ocrPages }`: hands over the extracted text. */
  async ingest(matterId: number, docId: number, manifest: IngestManifest): Promise<{ ocrPages: number }> {
    const answer = await this.#request("POST", `${documentsPath(matterId)}/${docId}/ingest`, manifest);
    return { ocrPages: member<number>(answer, "ocrPages", Number.isInteger) };
  }

  /** `POST …/documents/{docId}/process`, without a body: runs the next batch of processing. */
  async process(matterId: number, docId: number): Promise<ProcessResult> {
    return object<ProcessResult>(await this.#request("POST", `${documentsPath(matterId)}/${docId}/process`));
  }

  /** `GET …/documents/{docId}` → `{ document }`. */
  async getDocument(matterId: number, docId: number): Promise<MatterDocumentDetail> {
    const answer = await this.#request("GET", `${documentsPath(matterId)}/${docId}`);
    return member<MatterDocumentDetail>(answer, "document", isRecord);
  }

  /**
   * `POST …/documents/upload` with the event `@vercel/blob/client` sends to its handleUploadUrl:
   * the client token that lets this one upload put `pathname` (under the matter's prefix) in the
   * private store.
   */
  async requestUploadToken(matterId: number, pathname: string): Promise<string> {
    const event = { type: "blob.generate-client-token", payload: { pathname, clientPayload: null, multipart: false } };
    const answer = await this.#request("POST", `${documentsPath(matterId)}/upload`, event);
    return member<string>(answer, "clientToken", isNonEmptyString);
  }

  /**
   * Sends the request with the session's access token and returns the success answer. After a
   * 401 it asks onUnauthorized() once for a fresh token and sends the request again with it. A
   * refusal throws the ApiError of the last answer: a second 401, or a 401 for which there is no
   * fresh token, included. Without a token nothing is sent: ApiError(401, "not_signed_in"). A
   * failure of getToken() or onUnauthorized() (the sign-in service unreachable) and a request that
   * got no answer reject with their own error, untouched.
   */
  async #request(method: Method, path: string, body?: unknown): Promise<Answer> {
    const token = await this.#deps.getToken();
    if (token === null) throw new ApiError(401, "not_signed_in");
    let answer = await this.#send(method, path, token, body);
    if (answer.status === 401) {
      const fresh = await this.#deps.onUnauthorized();
      if (fresh !== null) answer = await this.#send(method, path, fresh, body);
    }
    if (!answer.ok) throw refusal(answer);
    return answer;
  }

  /**
   * One request to `${baseUrl}${path}`, `body` sent as JSON. A redirect is refused (fetch rejects),
   * so neither the bearer nor a body holding a document's text is ever sent to another origin. The
   * answer's body is read in full before the next request is made.
   */
  async #send(method: Method, path: string, token: string, body: unknown): Promise<Answer> {
    const { baseUrl, fetchImpl } = this.#deps;
    const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
    });
    return { ok: res.ok, status: res.status, body: await jsonBody(res) };
  }
}

function documentsPath(matterId: number): string {
  return `/api/matters/${matterId}/documents`;
}

/**
 * The body as JSON, or undefined when it is not JSON; the parser's error is dropped, as its
 * message quotes the body. A body cut off while being read rejects with the stream's own error,
 * like a request that got no answer.
 */
async function jsonBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The ApiError for an error answer: the body's error string as the code (else http_<status>), the rest as metadata. */
function refusal({ status, body }: Answer): ApiError {
  if (!isRecord(body)) return new ApiError(status, `http_${status}`);
  const code = typeof body.error === "string" && body.error !== "" ? body.error : `http_${status}`;
  const metadata = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "error" && key !== "message"));
  return new ApiError(status, code, metadata);
}

/** The answer's body, when it is a JSON object; its fields are trusted to be T's. */
function object<T>(answer: Answer): T {
  if (!isRecord(answer.body)) throw invalidResponse(answer);
  return answer.body as T;
}

/** The member `key` of the answer's JSON object, when `accepts` accepts it; its fields are trusted to be T's. */
function member<T>(answer: Answer, key: string, accepts: (value: unknown) => boolean): T {
  const value = object<Record<string, unknown>>(answer)[key];
  if (!accepts(value)) throw invalidResponse(answer);
  return value as T;
}

function invalidResponse({ status }: Answer): ApiError {
  return new ApiError(status, "invalid_response");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}
