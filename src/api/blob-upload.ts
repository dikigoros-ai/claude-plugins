// Puts a file's bytes, or the JPEG of a scanned page, in the DIKIGOROS private blob store, as the
// web uploader does with @vercel/blob/client. The API hands out a client token for this one
// pathname under the matter's prefix (DikigorosApi.requestUploadToken, which sends the session's
// bearer and retries a 401 once); the bytes then go straight to the store with that token, never
// through the API. The store is the SDK's default (https://vercel.com/api/blob) unless
// VERCEL_BLOB_API_URL is set, which the SDK reads on every request (the tests point it at a local
// server).

import { put } from "@vercel/blob/client";
import type { DikigorosApi } from "./client";
import { ApiError } from "./errors";

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
}

/**
 * Uploads `bytes` to `pathname` in the private store and returns the blob's URL, the one the API
 * registers as a document's blobUrl or a page's imageBlobKey. A failure of the token request
 * rejects with its own error, untouched: the client's ApiError, or the error of a request that
 * got no answer. A failure of the upload itself, the store's refusal or no store to reach, is
 * ApiError(502, "blob_upload_failed", { message }) holding the first line of the SDK's message.
 * The SDK first retries a connection failure, or a store error coded internal_server_error,
 * service_unavailable or unknown_error (or not coded at all), VERCEL_BLOB_RETRIES times (10 by
 * default, waiting 1 to 2 s and doubling each time): a store that stays down is reported only
 * after 17 to 34 minutes. Any other refusal is final at once. Neither the client token nor the
 * bytes are ever part of an error.
 */
export async function uploadBlob({ api, matterId, pathname, bytes, contentType }: BlobUploadArgs): Promise<{ url: string }> {
  const clientToken = await api.requestUploadToken(matterId, pathname);
  // The DOM lib's BlobPart admits views of an ArrayBuffer only; Node's Blob copies any view.
  const body = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: contentType });
  try {
    const { url } = await put(pathname, body, {
      access: "private",
      token: clientToken,
      contentType,
    });
    return { url };
  } catch (err) {
    throw new ApiError(502, "blob_upload_failed", { message: failureMessage(err, clientToken) });
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
