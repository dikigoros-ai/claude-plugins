import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type BlobContentType, uploadBlob } from "./blob-upload";
import type { DikigorosApi } from "./client";
import { ApiError } from "./errors";

/**
 * The client token the fake API hands out. `put` from @vercel/blob/client refuses a token without
 * the `vercel_blob_client_` prefix before it sends anything, so a bare "ct_test" never reaches the
 * store; this one has the shape the server's tokens have (`vercel_blob_client_<storeId>_…`).
 */
const CLIENT_TOKEN = "vercel_blob_client_teststore_ct_test";
const STORE_URL = "https://teststore.private.blob.vercel-storage.com/";
const PDF = "application/pdf";

/**
 * A file's bytes as the pipeline hands them over: a view into a larger buffer (as a pooled Buffer
 * is), 150 KB so the body reaches the store in several chunks, with a marker no error may show.
 */
const FILE = Buffer.concat([
  Buffer.from("<before>"),
  Buffer.from("%PDF-1.7\n% file-secret-5d1e\n"),
  Buffer.alloc(150_000, "."),
  Buffer.from("<after>"),
]);
const BYTES = FILE.subarray("<before>".length, FILE.length - "<after>".length);

// ---------- The fake private store ----------

/** A request as the store saw it, its body read in full before the answer. */
interface StoreRequest {
  method: string | undefined;
  /** The path without the query. */
  path: string;
  /** The `pathname` query parameter, decoded: the SDK sends the blob's pathname there. */
  pathname: string | null;
  authorization: string | undefined;
  /** `x-content-type`: the type the store keeps the blob under. */
  storedType: string | undefined;
  /** `content-type`: the type of the Blob the body was made from. */
  bodyType: string | undefined;
  /** `x-vercel-blob-access`. */
  access: string | undefined;
  body: Buffer;
}

/** What the store answers: the blob, or a Vercel Blob error body with an error status. */
type StoreAnswer = { status: 200 } | { status: number; error: { code: string; message: string } };

const store: { requests: StoreRequest[]; answer: StoreAnswer } = { requests: [], answer: { status: 200 } };

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(", ") : value;
}

/** Records the request, its body read to the end, then answers as `store.answer` says. */
async function receive(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.searchParams.get("pathname");
  const storedType = header(req, "x-content-type");
  store.requests.push({
    method: req.method,
    path: url.pathname,
    pathname,
    authorization: header(req, "authorization"),
    storedType,
    bodyType: header(req, "content-type"),
    access: header(req, "x-vercel-blob-access"),
    body: Buffer.concat(chunks),
  });
  const { answer } = store;
  const body =
    "error" in answer
      ? { error: answer.error }
      : { url: `${STORE_URL}${pathname}-abc123`, pathname, contentType: storedType, contentDisposition: "" };
  res.writeHead(answer.status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  void receive(req, res);
});
let storeApiUrl = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  storeApiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/blob-store`;
  // The SDK retries a connection failure, or a store error such as internal_server_error,
  // VERCEL_BLOB_RETRIES times (10 by default), backing off from 1 s; here every failure is final.
  vi.stubEnv("VERCEL_BLOB_RETRIES", "0");
});

beforeEach(() => {
  // The SDK reads the store's URL on every request (getApiUrl in requestApi), not on import, so
  // it can be set once the store listens; a test may point it elsewhere.
  vi.stubEnv("VERCEL_BLOB_API_URL", storeApiUrl);
  store.requests = [];
  store.answer = { status: 200 };
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

// ---------- Helpers ----------

/** The API part uploadBlob uses: requestUploadToken, recording its calls, answering CLIENT_TOKEN unless told otherwise. */
function fakeApi(answer: () => Promise<string> = async () => CLIENT_TOKEN) {
  return { requestUploadToken: vi.fn<DikigorosApi["requestUploadToken"]>(answer) };
}

function uploadClaim(api = fakeApi()) {
  return uploadBlob({ api, matterId: 2, pathname: "matters/u1/m2/claim.pdf", bytes: BYTES, contentType: PDF });
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

/** Neither the client token nor the file's bytes, anywhere in the error. */
function expectNoSecrets(err: unknown): void {
  const everything = inspect(err, { depth: null, showHidden: true });
  expect(everything).not.toContain(CLIENT_TOKEN);
  expect(everything).not.toContain("file-secret-5d1e");
}

/** A store URL on 127.0.0.1 where nothing listens: a port that was just let go. */
async function unreachableStoreUrl(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}/blob-store`;
}

// ---------- The upload ----------

describe("uploadBlob", () => {
  it("asks the API for a client token for the matter and the pathname", async () => {
    const api = fakeApi();
    await uploadClaim(api);
    expect(api.requestUploadToken.mock.calls).toEqual([[2, "matters/u1/m2/claim.pdf"]]);
  });

  // A loop rather than it.each, which would cut the titles at 40 characters.
  for (const { pathname, contentType } of [
    { pathname: "matters/u1/m2/claim.pdf", contentType: PDF },
    {
      pathname: "matters/u1/m2/brief.docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    { pathname: "matters/u1/m2/pages/p2.jpg", contentType: "image/jpeg" },
  ] satisfies Array<{ pathname: string; contentType: BlobContentType }>) {
    it(`PUTs ${pathname} to the private store with the client token as the bearer, ${contentType} and every byte`, async () => {
      const result = await uploadBlob({ api: fakeApi(), matterId: 2, pathname, bytes: BYTES, contentType });
      expect(result).toStrictEqual({ url: `${STORE_URL}${pathname}-abc123` });
      expect(store.requests).toHaveLength(1);
      const [{ body, ...request }] = store.requests;
      expect(request).toEqual({
        method: "PUT",
        path: "/blob-store/",
        pathname,
        authorization: `Bearer ${CLIENT_TOKEN}`,
        storedType: contentType,
        bodyType: contentType,
        access: "private",
      });
      expect(body.length).toBe(BYTES.length);
      expect(body.equals(BYTES)).toBe(true);
    });
  }

  it("keeps a Greek filename with spaces in the pathname", async () => {
    const pathname = "matters/u1/m2/Αγωγή αρ. 5.pdf";
    const api = fakeApi();
    const result = await uploadBlob({ api, matterId: 2, pathname, bytes: BYTES, contentType: PDF });
    expect(api.requestUploadToken.mock.calls).toEqual([[2, pathname]]);
    expect(store.requests.map((request) => request.pathname)).toEqual([pathname]);
    expect(result).toStrictEqual({ url: "https://teststore.private.blob.vercel-storage.com/matters/u1/m2/Αγωγή αρ. 5.pdf-abc123" });
  });
});

describe("a failed upload", () => {
  it("a store answering 500 rejects with ApiError(502, blob_upload_failed) and the SDK's message", async () => {
    store.answer = { status: 500, error: { code: "internal_server_error", message: "The store is down." } };
    const err = await refused(uploadClaim());
    expect(shown(err)).toEqual({
      status: 502,
      code: "blob_upload_failed",
      metadata: { message: "Vercel Blob: Unknown error, please visit https://vercel.com/help." },
      message: "502 blob_upload_failed",
    });
    expect(store.requests).toHaveLength(1);
    expectNoSecrets(err);
  });

  it("keeps the first line of the failure's message only", async () => {
    store.answer = { status: 400, error: { code: "bad_request", message: "Invalid pathname\n    at the store" } };
    const err = await refused(uploadClaim());
    expect(shown(err)).toEqual({
      status: 502,
      code: "blob_upload_failed",
      metadata: { message: "Vercel Blob: Invalid pathname" },
      message: "502 blob_upload_failed",
    });
  });

  it("a store that cannot be reached rejects with ApiError(502, blob_upload_failed)", async () => {
    vi.stubEnv("VERCEL_BLOB_API_URL", await unreachableStoreUrl());
    const err = await refused(uploadClaim());
    expect(shown(err)).toEqual({
      status: 502,
      code: "blob_upload_failed",
      metadata: { message: "fetch failed" },
      message: "502 blob_upload_failed",
    });
    expectNoSecrets(err);
  });

  it("never shows the client token, even when the failure's message quotes the bearer", async () => {
    // A token no server sends: undici refuses the header, and its message quotes the header's value.
    const token = "vercel_blob_client_teststore_ct\ntest";
    const err = await refused(uploadClaim(fakeApi(async () => token)));
    expect(shown(err)).toEqual({
      status: 502,
      code: "blob_upload_failed",
      metadata: { message: 'Headers.append: "Bearer [client token]" is an invalid header value.' },
      message: "502 blob_upload_failed",
    });
    expect(inspect(err, { depth: null, showHidden: true })).not.toContain("vercel_blob_client_teststore_ct");
    expect(store.requests).toEqual([]);
  });

  for (const { what, failure } of [
    { what: "refusal", failure: new ApiError(403, "entitlement_required", { entitlement: "mattersAccess" }) },
    { what: "network failure", failure: new TypeError("fetch failed") },
  ]) {
    it(`lets the token request's ${what} through as it is, with nothing sent to the store`, async () => {
      await expect(uploadClaim(fakeApi(() => Promise.reject(failure)))).rejects.toBe(failure);
      expect(store.requests).toEqual([]);
    });
  }
});
