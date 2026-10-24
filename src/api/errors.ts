// A refusal from the DIKIGOROS API, and the one place a refusal becomes a sentence the lawyer can
// act on. An ApiError carries the HTTP status, the server's error code and the rest of its error
// body; never a token, a request body or an answer that was not JSON. describeApiError reads
// those fields and the base URL, nothing else. No plan is named but in the plan sentence, and no
// price, trial or comparison is ever named (spec §7.5).

/**
 * The API refused a request, or answered it in a way the client cannot use. `code` is the error
 * body's `error` string (a snake_case code such as `document_limit_reached`, or a sentence such as
 * `Authentication required`), `http_<status>` for an error answer without one, `not_signed_in`
 * when there was no token to send, or `invalid_response` for a success answer the route does not
 * send. `metadata` is the rest of the error body, less `error` and `message`.
 */
export class ApiError extends Error {
  override name = "ApiError";

  constructor(
    public status: number,
    public code: string,
    public metadata: Record<string, unknown> = {},
  ) {
    super(`${status} ${code}`);
  }
}

const SIGN_IN_AGAIN = "Sign in again: call the tool once more and follow the sign-in instructions.";

/** The sentence for `err`; `baseUrl` is the origin whose plans page the plan sentence links. */
export function describeApiError(err: ApiError, baseUrl: string): string {
  const limit = numberIn(err.metadata, "limit");
  switch (err.code) {
    case "entitlement_required":
      return `This needs the Firm plan (Matters). Plans: ${baseUrl}/pricing`;
    case "account_suspended":
      return "This DIKIGOROS account has been suspended.";
    case "email_not_verified":
      return "Verify this DIKIGOROS account's email address first, then try again.";
    case "not_signed_in":
      return SIGN_IN_AGAIN;
    case "matter_limit_reached":
      return limit === undefined ? "Matter limit reached." : `Matter limit reached (${limit} active matters).`;
    case "document_limit_reached":
      return limit === undefined ? "Document limit reached." : `Document limit reached (${limit} per matter).`;
    case "duplicate_document": {
      const documentId = numberIn(err.metadata, "documentId");
      return documentId === undefined
        ? "This file is already in the matter."
        : `This file is already in the matter (document #${documentId}).`;
    }
    case "Weekly usage limit reached":
      return "The weekly usage allowance is used up; it resets on Sunday 00:00 UTC.";
    case "too_many_ocr_pages":
      return limit === undefined
        ? "Too many pages need OCR; split the file into smaller ones."
        : `Too many pages need OCR (at most ${limit} per document); split the file into smaller ones.`;
    case "manifest_too_large":
      return "The extracted text is too large to store; split the file into smaller ones.";
    case "processing_in_progress":
      return "The document is already being processed; try again in a moment.";
    default:
      if (err.status === 401) return SIGN_IN_AGAIN;
      if (err.status === 404) return "Matter not found (or not yours).";
      return `${err.status} ${err.code}`;
  }
}

/** `metadata[key]` when it is a number; the sentences leave out a number the body did not carry. */
function numberIn(metadata: Record<string, unknown>, key: string): number | undefined {
  const value = metadata[key];
  return typeof value === "number" ? value : undefined;
}
