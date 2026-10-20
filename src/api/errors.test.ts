import { describe, expect, it } from "vitest";
import { ApiError, describeApiError } from "./errors";

const BASE = "https://dikigoros.ai";

const SIGN_IN_AGAIN = "Sign in again: call the tool once more and follow the sign-in instructions.";
const MATTER_NOT_FOUND = "Matter not found (or not yours).";

describe("ApiError", () => {
  it("carries the status, the code and the metadata, and its message is only `<status> <code>`", () => {
    const err = new ApiError(429, "document_limit_reached", { limit: 50 });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ApiError");
    expect({ status: err.status, code: err.code, metadata: err.metadata, message: err.message }).toEqual({
      status: 429,
      code: "document_limit_reached",
      metadata: { limit: 50 },
      message: "429 document_limit_reached",
    });
  });

  it("has empty metadata when none is given", () => {
    expect(new ApiError(401, "not_signed_in").metadata).toEqual({});
  });
});

describe("describeApiError", () => {
  // The error bodies are the ones the DIKIGOROS routes send, less `error` and `message`.
  it.each([
    {
      status: 403,
      code: "entitlement_required",
      metadata: { entitlement: "mattersAccess", requiredPlan: "firm" },
      sentence: "This needs the Firm plan (Matters). Plans: https://dikigoros.ai/pricing",
    },
    { status: 403, code: "account_suspended", metadata: {}, sentence: "This DIKIGOROS account has been suspended." },
    {
      status: 403,
      code: "email_not_verified",
      metadata: { email: "lawyer@example.com" },
      sentence: "Verify this DIKIGOROS account's email address first, then try again.",
    },
    { status: 401, code: "not_signed_in", metadata: {}, sentence: SIGN_IN_AGAIN },
    { status: 401, code: "Authentication required", metadata: {}, sentence: SIGN_IN_AGAIN },
    { status: 401, code: "http_401", metadata: {}, sentence: SIGN_IN_AGAIN },
    { status: 404, code: "Not found", metadata: {}, sentence: MATTER_NOT_FOUND },
    { status: 404, code: "http_404", metadata: {}, sentence: MATTER_NOT_FOUND },
    { status: 429, code: "matter_limit_reached", metadata: { limit: 10 }, sentence: "Matter limit reached (10 active matters)." },
    { status: 429, code: "document_limit_reached", metadata: { limit: 50 }, sentence: "Document limit reached (50 per matter)." },
    {
      status: 409,
      code: "duplicate_document",
      metadata: { documentId: 31 },
      sentence: "This file is already in the matter (document #31).",
    },
    {
      status: 429,
      code: "Weekly usage limit reached",
      metadata: { limit: 3_800_000, used: 3_800_412, remaining: 0, plan: "firm" },
      sentence: "The weekly usage allowance is used up; it resets on Sunday 00:00 UTC.",
    },
    {
      status: 413,
      code: "too_many_ocr_pages",
      metadata: { limit: 300 },
      sentence: "Too many pages need OCR (at most 300 per document); split the file into smaller ones.",
    },
    {
      status: 413,
      code: "manifest_too_large",
      metadata: {},
      sentence: "The extracted text is too large to store; split the file into smaller ones.",
    },
    {
      status: 409,
      code: "processing_in_progress",
      metadata: {},
      sentence: "The document is already being processed; try again in a moment.",
    },
    { status: 400, code: "Invalid role", metadata: {}, sentence: "400 Invalid role" },
    { status: 409, code: "Document is not pending ingest", metadata: {}, sentence: "409 Document is not pending ingest" },
    { status: 502, code: "http_502", metadata: {}, sentence: "502 http_502" },
    { status: 200, code: "invalid_response", metadata: {}, sentence: "200 invalid_response" },
  ])("$status $code", ({ status, code, metadata, sentence }) => {
    expect(describeApiError(new ApiError(status, code, metadata), BASE)).toBe(sentence);
  });

  it("links the pricing page of the base URL it is given", () => {
    const err = new ApiError(403, "entitlement_required", { entitlement: "mattersAccess", requiredPlan: "firm" });
    expect(describeApiError(err, "http://localhost:3000")).toBe(
      "This needs the Firm plan (Matters). Plans: http://localhost:3000/pricing",
    );
  });

  it.each([
    { status: 429, code: "matter_limit_reached", metadata: {}, sentence: "Matter limit reached." },
    { status: 429, code: "document_limit_reached", metadata: { limit: "50" }, sentence: "Document limit reached." },
    { status: 409, code: "duplicate_document", metadata: { documentId: null }, sentence: "This file is already in the matter." },
    {
      status: 413,
      code: "too_many_ocr_pages",
      metadata: { limit: [300] },
      sentence: "Too many pages need OCR; split the file into smaller ones.",
    },
  ])("leaves the number out of $code when the error body has no number for it", ({ status, code, metadata, sentence }) => {
    expect(describeApiError(new ApiError(status, code, metadata), BASE)).toBe(sentence);
  });
});
