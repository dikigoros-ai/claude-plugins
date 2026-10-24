// Puts a file's bytes, or the JPEG of a scanned page, in the DIKIGOROS private blob store, as the
// web uploader does with @vercel/blob/client. The API hands out a client token for this one
// pathname under the matter's prefix (DikigorosApi.requestUploadToken, which sends the session's
// bearer and retries a 401 once); the bytes then go straight to the store with that token, never
// through the API. The store is the SDK's default (https://vercel.com/api/blob) unless
// VERCEL_BLOB_API_URL, or else NEXT_PUBLIC_VERCEL_BLOB_API_URL, is set; the SDK reads them on
// every upload (the tests point the first at a local server).

import { put } from "@vercel/blob/client";
import type { DikigorosApi } from "./client";
import { ApiError } from "./errors";

/** How long an upload may run before it is aborted: a 50 MB file still fits at 0.7 Mbit/s. */
export const BLOB_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/** What the upload route's token allows: a PDF or DOCX original, or the JPEG of a scanned page. */
export type BlobContentType =
  | "application/pdf"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "image/jpeg";

export interface BlobUploadArgs {
  api: Pick<DikigorosApi, "requestUploadToken">;
  matterId: number;
  /** The matter's prefix and the file's own name, verbatim: the SDK encodes it, the store decodes it. */
  pathname: string;
  bytes: Uint8Array;
  contentType: BlobContentType;
  /** How long the upload may run before it is aborted; BLOB_UPLOAD_TIMEOUT_MS unless given. */
  timeoutMs?: number;
}

/**
 * Uploads `bytes` to `pathname` in the private store and returns the blob's URL, the one the API
 * registers as a document's blobUrl or a page's imageBlobKey. A failure of the token request
 * rejects with its own error, untouched: the client's ApiError, or the error of a request that
 * got no answer. A failure of the upload itself, the store's refusal or no store to reach, is
 * ApiError(502, "blob_upload_failed", { message }) holding the first line of the SDK's message.
 * The SDK first retries a connection failure, or a store error coded internal_server_error,
 * service_unavailable or unknown_error (or not coded at all), VERCEL_BLOB_RETRIES times (10 by
 * default, waiting 1 to 2 s and doubling each time, 17 to 34 minutes in all); any other refusal
 * is final at once. An upload still running after `timeoutMs` is aborted, which the SDK does not
 * retry: an attempt in flight ends at once, a wait between attempts at its end. It rejects with
 * ApiError(502, "blob_upload_failed", { message: "upload timed out" }). Neither the client token
 * nor the bytes are ever part of an error.
 */
export async function uploadBlob({
  api,
  matterId,
  pathname,
  bytes,
  contentType,
  timeoutMs = BLOB_UPLOAD_TIMEOUT_MS,
}: BlobUploadArgs): Promise<{ url: string }> {
  const clientToken = await api.requestUploadToken(matterId, pathname);
  // The DOM lib's BlobPart admits views of an ArrayBuffer only; Node's Blob copies any view.
  const body = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: contentType });
  // An AbortError, which the SDK gives up on; AbortSignal.timeout()'s TimeoutError it would retry.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { url } = await put(pathname, body, {
      access: "private",
      token: clientToken,
      contentType,
      abortSignal: controller.signal,
    });
    return { url };
  } catch (err) {
    const message = controller.signal.aborted ? "upload timed out" : failureMessage(err, clientToken);
    throw new ApiError(502, "blob_upload_failed", { message });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The first line of the failure's message, the client token cut out of it: undici's message for a
 * header value it refuses quotes the value, and the bearer is one.
 */
function failureMessage(err: unknown, clientToken: string): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replaceAll(clientToken, "[client token]").split(/\r?\n/, 1)[0];
}
