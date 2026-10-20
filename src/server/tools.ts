// The two tools of the dikigoros-upload server. upload_to_matter lists the files a call names and
// uploads them into a matter only when a second call confirms the listing; create_matter opens a
// matter. Both make sure of the sign-in first: with nobody signed in, the result is the prompt of a
// new device-flow sign-in. A refusal of the API is answered with its sentence (../api/errors), and
// no answer at all with a sentence saying what was not done. No result carries a token, the device
// code, an error's metadata or a file's bytes.

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { DikigorosApi, Matter } from "../api/client";
import { ApiError, describeApiError } from "../api/errors";
import type { AuthSession, SignInPrompt } from "../auth/session";
import type { HelperConfig } from "../config";
import { MAX_PATHS_PER_CALL, type PlanEntry, type resolveUploadPlan, type UploadPlan } from "../files/resolve";
import type { DocumentOutcome, UploadContext } from "../pipeline/upload-document";

// Ported from dikigoros-ai/dikigoros-ai lib/matters.ts @ 37f39ac5 (2026-10-19): the matter types,
// the roles a lawyer may give a document (every role but `generated`, which the server alone
// writes), and the sides.
export const MATTER_TYPES = ["civil", "criminal", "interim_application", "appeal", "other"] as const;
export const MATTER_UPLOAD_ROLES = [
  "statement_of_claim",
  "defense",
  "reply",
  "affidavit",
  "opposition",
  "witness_statement",
  "exhibit",
  "interim_application",
  "court_order",
  "correspondence",
  "other",
  "written_submission",
  "judgment",
  "expert_report",
  "minutes",
  "notice",
  "bundle",
] as const; // lib/matters.ts MATTER_UPLOAD_ROLES @ 37f39ac5
export const MATTER_SIDES = ["ours", "theirs", "neutral"] as const;

/** The part of the sign-in the tools use. */
export type SessionLike = Pick<AuthSession, "status" | "getAccessToken" | "beginSignIn" | "forgetSession">;

export interface ToolDeps {
  config: HelperConfig;
  session: SessionLike;
  api: DikigorosApi;
  resolvePlan: typeof resolveUploadPlan;
  /** One planned file into the matter, followed to its outcome (../pipeline/upload-document). */
  upload: (entry: PlanEntry, ctx: UploadContext) => Promise<DocumentOutcome>;
  /** The native runtime the PDF extraction needs, installed on first use; rejects when it cannot be. */
  nativeRuntime: () => Promise<unknown>;
  /** Why the sign-in is kept in memory only, when the OS keychain is not available; else null. */
  tokenStoreWarning: () => Promise<string | null>;
}

const uploadToMatterInput = z.object({
  matter_id: z.number().int().positive(),
  paths: z.array(z.string().min(1).max(1024)).min(1).max(MAX_PATHS_PER_CALL),
  role: z.enum(MATTER_UPLOAD_ROLES).optional(),
  side: z.enum(MATTER_SIDES).optional(),
  confirm: z.boolean().optional(),
  plan_digest: z.string().optional(),
});

const createMatterInput = z.object({
  title: z.string().trim().min(1).max(300),
  type: z.enum(MATTER_TYPES).optional(),
  case_reference: z.string().max(300).optional(),
  description: z.string().max(2000).optional(),
});

export type UploadToMatterArgs = z.infer<typeof uploadToMatterInput>;
export type CreateMatterArgs = z.infer<typeof createMatterInput>;

const ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const NOT_CONFIGURED = "The helper is not configured (DIKIGOROS_AUTH0_CLIENT_ID is empty).";

/** Registers upload_to_matter and create_matter on `server`, both answering with `deps`. */
export function registerTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "upload_to_matter",
    {
      title: "Upload files to a matter",
      description:
        "Use this when the lawyer asks to add files from this computer to a DIKIGOROS matter. Takes absolute paths " +
        "to .pdf, .docx, .txt or .md files, or to a folder (its top-level files). The first call lists what would be " +
        "uploaded and uploads nothing; call again with confirm: true to upload. Not for files already in the matter, " +
        "other file types, or for searching or reading matter documents.",
      inputSchema: uploadToMatterInput,
      annotations: ANNOTATIONS,
    },
    (args) => handleUploadToMatter(args, deps),
  );
  server.registerTool(
    "create_matter",
    {
      title: "Create a matter",
      description:
        "Use this when the lawyer asks to open a new matter in DIKIGOROS, for example before uploading files to it. " +
        "Creates the matter with a title and optional type, case reference and description. Not for changing, " +
        "archiving or deleting an existing matter.",
      inputSchema: createMatterInput,
      annotations: ANNOTATIONS,
    },
    (args) => handleCreateMatter(args, deps),
  );
}

/**
 * upload_to_matter. Without `confirm: true` it lists the plan for `paths` and uploads nothing. With
 * it, unless a plan_digest no longer matches the files, it checks the account and the matter's
 * document limit, then uploads the planned files one after another and reports each.
 */
export async function handleUploadToMatter(args: UploadToMatterArgs, deps: ToolDeps): Promise<CallToolResult> {
  const blocked = await signInGate(deps);
  if (blocked !== null) return blocked;
  try {
    const plan = await deps.resolvePlan(args.paths);
    if (args.confirm !== true) return listing("confirmation_required", plan);
    if (args.plan_digest !== undefined && args.plan_digest !== plan.digest) return listing("plan_changed", plan);
    const uploads = plan.entries.filter((entry) => entry.decision === "upload");
    if (uploads.length === 0) return answer("Nothing to upload.");
    return await uploadPlanned(args, uploads, deps);
  } catch (err) {
    return failureAfterSignIn(err, deps.config.baseUrl, "Nothing was uploaded; try again in a moment.");
  }
}

/** create_matter: opens a matter with the title and whichever optional fields are given. */
export async function handleCreateMatter(args: CreateMatterArgs, deps: ToolDeps): Promise<CallToolResult> {
  const blocked = await signInGate(deps);
  if (blocked !== null) return blocked;
  const { baseUrl } = deps.config;
  let matter: Matter;
  try {
    matter = await deps.api.createMatter({
      title: args.title,
      matterType: args.type,
      caseReference: args.case_reference,
      description: args.description,
    });
  } catch (err) {
    // The route refused the token, even a refreshed one: the session is dead. A not_signed_in was
    // never sent (there was no token), and the next call's sign-in gate starts a sign-in anyway.
    if (err instanceof ApiError && err.status === 401 && err.code !== "not_signed_in") {
      return restartSignIn(deps.session);
    }
    const undone = `The matter may not have been created; check ${baseUrl}/matters before trying again.`;
    return failureAfterSignIn(err, baseUrl, undone);
  }
  const url = `${baseUrl}/matters/${matter.id}`;
  return answer(`Created matter #${matter.id} "${matter.title}" — ${url}`, {
    matter: {
      id: matter.id,
      title: matter.title,
      matter_type: matter.matterType,
      case_reference: matter.caseReference,
      status: matter.status,
      url,
    },
  });
}

/**
 * What a confirmed call does with the files its plan uploads: the account, the matter's document
 * limit, the native runtime when a PDF is among them, then the uploads one at a time.
 */
async function uploadPlanned(args: UploadToMatterArgs, uploads: PlanEntry[], deps: ToolDeps): Promise<CallToolResult> {
  const { config, session, api } = deps;
  // A 401 from this allowlisted route, after the client's retry with a refreshed token: the session is dead.
  const me = await api.currentUser().catch(nullOn401);
  if (me === null) return restartSignIn(session);
  if (!me.entitlements.mattersAccess) {
    return failure(describeApiError(new ApiError(403, "entitlement_required"), config.baseUrl));
  }
  const { documents } = await api.getMatter(args.matter_id);
  const limit = me.entitlements.docsPerMatter;
  if (limit !== -1 && documents.length + uploads.length > limit) {
    return failure(
      `Matter #${args.matter_id} holds ${documents.length} of ${limit} documents; ` +
        `${uploads.length} more would exceed the limit. Nothing was uploaded.`,
    );
  }
  // Without the native runtime no PDF can be read; the other files do not need it.
  const runtimeFailure = uploads.some((entry) => entry.kind === "pdf")
    ? await deps.nativeRuntime().then(() => null, firstLine)
    : null;
  const ctx: UploadContext = {
    baseUrl: config.baseUrl,
    userId: me.id,
    matterId: args.matter_id,
    role: args.role,
    side: args.side,
  };
  const outcomes: DocumentOutcome[] = [];
  for (const entry of uploads) {
    outcomes.push(
      entry.kind === "pdf" && runtimeFailure !== null
        ? { name: entry.name, status: "failed", code: "native_runtime_unavailable", message: runtimeFailure }
        : await deps.upload(entry, ctx),
    );
  }
  return report(args.matter_id, outcomes, deps);
}

/** The outcomes, one line per file, then the matter's URL and the keychain warning when there is one. */
async function report(matterId: number, outcomes: DocumentOutcome[], deps: ToolDeps): Promise<CallToolResult> {
  const matterUrl = `${deps.config.baseUrl}/matters/${matterId}`;
  const lines = outcomes.map(({ name, status, message }) =>
    message === undefined ? `${name}: ${status}` : `${name}: ${status} — ${message}`,
  );
  lines.push(`Matter #${matterId}: ${matterUrl}`);
  const warning = await deps.tokenStoreWarning();
  if (warning !== null) lines.push(warning);
  const results = outcomes.map((outcome) => ({
    name: outcome.name,
    status: outcome.status,
    doc_id: outcome.documentId,
    page_count: outcome.pageCount,
    ocr_pages: outcome.ocrPages,
    ocr_remaining: outcome.ocrRemaining,
    code: outcome.code,
    message: outcome.message,
    role_applied: outcome.roleApplied,
  }));
  return answer(lines.join("\n"), { status: "done", matter_id: matterId, matter_url: matterUrl, results });
}

/** The plan, a line per file and per named path without one, and how to confirm it. */
function listing(status: "confirmation_required" | "plan_changed", plan: UploadPlan): CallToolResult {
  const marked = plan.entries.filter((entry) => entry.decision === "upload").length;
  const lines = [
    ...(status === "plan_changed" ? ["The files have changed since they were listed."] : []),
    ...plan.entries.map(row),
    ...plan.emptyPaths.map((path) => `${path}: no eligible files`),
    `Nothing has been uploaded. Call again with confirm: true and plan_digest "${plan.digest}" ` +
      `to upload the ${marked} file(s) marked upload.`,
  ];
  const files = plan.entries.map((entry) => ({
    name: entry.name,
    path: entry.path,
    size_bytes: entry.sizeBytes,
    type: entry.kind,
    decision: entry.decision,
    reason: entry.reason,
  }));
  return answer(lines.join("\n"), { status, plan_digest: plan.digest, files, empty_paths: plan.emptyPaths });
}

/** name · size · type · decision; "—" for a size or a type the entry does not have. */
function row(entry: PlanEntry): string {
  const size = entry.realPath === "" ? "—" : formatSize(entry.sizeBytes); // the path never led to a file
  const decision = entry.decision === "upload" ? "upload" : `skip (${entry.reason})`;
  return [entry.name, size, entry.kind ?? "—", decision].join(" · ");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The first two steps of both tools: the result to answer with instead of going on, or null when
 * the helper is configured and someone is signed in. A sign-in that cannot be read or refreshed
 * changes nothing, as a new sign-in would throw away a session that may well still work.
 */
async function signInGate({ config, session }: ToolDeps): Promise<CallToolResult | null> {
  if (config.auth0ClientId === "") return failure(NOT_CONFIGURED);
  let token: string | null;
  try {
    token = await session.getAccessToken();
  } catch (err) {
    return signInUnreachable(err);
  }
  return token === null ? startSignIn(session) : null;
}

/** Forgets a session the server refused even after a refresh, and starts a new sign-in. */
async function restartSignIn(session: SessionLike): Promise<CallToolResult> {
  await session.forgetSession();
  return startSignIn(session);
}

/** Starts a sign-in, or finds the one in progress, and answers with its prompt for the lawyer. */
async function startSignIn(session: SessionLike): Promise<CallToolResult> {
  let prompt: SignInPrompt;
  try {
    prompt = await session.beginSignIn();
  } catch (err) {
    return signInUnreachable(err);
  }
  const minutes = Math.floor(prompt.expiresInSeconds / 60);
  return answer(
    `Sign in to DIKIGOROS first: open ${prompt.verificationUriComplete} and enter code ${prompt.userCode} ` +
      `(valid ${minutes} minutes). Then call this tool again.`,
    {
      status: "sign_in_required",
      verification_uri_complete: prompt.verificationUriComplete,
      user_code: prompt.userCode,
      expires_in_seconds: prompt.expiresInSeconds,
    },
  );
}

/** The sign-in service did not answer, or the keychain could not be read: nothing done, nothing lost. */
function signInUnreachable(err: unknown): CallToolResult {
  return failure(`Could not reach the sign-in service (${firstLine(err)}). Nothing was changed; try again in a moment.`);
}

/** A 401 as null, for the caller to read as a dead session; any other rejection stands. */
function nullOn401(err: unknown): null {
  if (err instanceof ApiError && err.status === 401) return null;
  throw err;
}

/**
 * A rejection after the sign-in gate as an error result: an ApiError's sentence; anything else (no
 * answer from DIKIGOROS, or from the sign-in service refreshing after a 401) says so with its first
 * line and what the call left `undone`, never as the SDK's raw error.
 */
function failureAfterSignIn(err: unknown, baseUrl: string, undone: string): CallToolResult {
  if (err instanceof ApiError) return failure(describeApiError(err, baseUrl));
  return failure(`Could not reach DIKIGOROS (${firstLine(err)}). ${undone}`);
}

/** A result: `text`, and the same facts as structured content when there are any. */
function answer(text: string, structuredContent?: Record<string, unknown>): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "text", text }];
  return structuredContent === undefined ? { content } : { content, structuredContent };
}

/** An error result: the call did not do what it was asked to. */
function failure(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split(/\r?\n/, 1)[0];
}
