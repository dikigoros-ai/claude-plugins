// The two tools of the dikigoros-upload server. upload_to_matter lists the files a call names and
// uploads them into a matter only when a second call confirms the listing with its digest;
// create_matter opens a matter. Both make sure of the sign-in first: with nobody signed in, the
// result is the prompt of a new device-flow sign-in. A refusal of the API is answered with its
// sentence (../api/errors), and no answer at all with a sentence saying what was not done. No result
// carries a token, the device code, an error's metadata or a file's bytes.

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { CurrentUser, DikigorosApi, Matter } from "../api/client";
import { ApiError, describeApiError } from "../api/errors";
import type { AuthSession, SignInPrompt } from "../auth/session";
import type { HelperConfig } from "../config";
import {
  MAX_PATHS_PER_CALL,
  type PlanEntry,
  type resolveUploadPlan,
  type SkipReason,
  type UploadPlan,
} from "../files/resolve";
import type { DocumentOutcome, UploadContext } from "../pipeline/upload-document";
import { firstLine } from "../util";

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
export type SessionLike = Pick<AuthSession, "getAccessToken" | "beginSignIn" | "forgetSession">;

export interface ToolDeps {
  config: HelperConfig;
  session: SessionLike;
  api: DikigorosApi;
  resolvePlan: typeof resolveUploadPlan;
  /**
   * One planned file into the matter, followed to its outcome (../pipeline/upload-document);
   * `onProgress`, when given, takes the pipeline's lines of OCR progress.
   */
  upload: (entry: PlanEntry, ctx: UploadContext, onProgress?: (message: string) => void) => Promise<DocumentOutcome>;
  /** The native runtime the PDF extraction needs, installed on first use; rejects when it cannot be. */
  nativeRuntime: () => Promise<unknown>;
  /** Why the sign-in is kept in memory only, when the OS keychain is not available; else null. */
  tokenStoreWarning: () => Promise<string | null>;
  /** The time, in milliseconds, that a call's budget is measured with. */
  now: () => number;
}

/**
 * The part of the SDK's request context a tool call reads: the signal the client's cancellation
 * aborts, the request's `_meta` (its progress token), and the method that sends a notification
 * about the request.
 */
export interface CallContext {
  mcpReq: Pick<ServerContext["mcpReq"], "signal" | "_meta" | "notify">;
}

/**
 * How long a confirmed call may run before it starts no more files: the files it has not started
 * are left for the next call, which finds the ones uploaded since as duplicates or resumes them.
 */
export const CALL_BUDGET_MS = 20 * 60 * 1000;

/** Why a planned file was not started: the call was cancelled, or ran past CALL_BUDGET_MS. */
const CANCELLED = { code: "cancelled", message: "not started: the call was cancelled" };
const OVER_BUDGET = {
  code: "call_budget",
  message:
    "not started: this call ran over 20 minutes; call again — files already uploaded are picked up as duplicates or resumed",
};

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

/** How many of the files it skips a listing names; the others are counted by reason. */
const SHOWN_SKIPS = 25;

/** The matter a call is about, and how many documents it holds of the plan's limit (-1: none). */
interface Holding {
  matterId: number;
  title: string;
  held: number;
  limit: number;
}

/** Registers upload_to_matter and create_matter on `server`, both answering with `deps`. */
export function registerTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "upload_to_matter",
    {
      title: "Upload files to a matter",
      description:
        "Use this when the lawyer asks to add files from this computer to a DIKIGOROS matter. Takes absolute paths " +
        "to .pdf, .docx, .txt or .md files, or to a folder (its top-level files). The first call lists what would be " +
        "uploaded and uploads nothing; call again with confirm: true and the plan_digest from that answer to upload. " +
        "Not for files already in the matter, other file types, or for searching or reading matter documents.",
      inputSchema: uploadToMatterInput,
      annotations: ANNOTATIONS,
    },
    (args, ctx) => handleUploadToMatter(args, deps, ctx),
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
 * upload_to_matter. Every call checks the account and the matter first, so that a matter that is not
 * there is said before any list. Unless the call carries `confirm: true` and the plan_digest of a
 * listing, it lists the plan for `paths` and uploads nothing; a plan_digest the files no longer match
 * lists them again. A confirmed call checks the matter's document limit, then uploads the planned
 * files one after another and reports each. `request`, the SDK's context of the call, can cancel
 * it between files and takes its progress notifications.
 */
export async function handleUploadToMatter(
  args: UploadToMatterArgs,
  deps: ToolDeps,
  request?: CallContext,
): Promise<CallToolResult> {
  const started = deps.now();
  const blocked = await signInGate(deps);
  if (blocked !== null) return blocked;
  const { config, session, api } = deps;
  try {
    // A 401 from this allowlisted route, after the client's retry with a refreshed token: the session is dead.
    const me = await api.currentUser().catch(nullOn401);
    if (me === null) return restartSignIn(session);
    if (!me.entitlements.mattersAccess) {
      return failure(describeApiError(new ApiError(403, "entitlement_required"), config.baseUrl));
    }
    const { matter, documents } = await api.getMatter(args.matter_id);
    const holding: Holding = {
      matterId: args.matter_id,
      title: matter.title,
      held: documents.length,
      limit: me.entitlements.docsPerMatter,
    };
    const plan = await deps.resolvePlan(args.paths);
    // confirm: true alone confirms nothing: only the digest says which listing the lawyer approved.
    if (args.confirm !== true || args.plan_digest === undefined) return listing("confirmation_required", plan, holding);
    if (args.plan_digest !== plan.digest) return listing("plan_changed", plan, holding);
    const uploads = plan.entries.filter((entry) => entry.decision === "upload");
    if (uploads.length === 0) return answer("Nothing to upload.");
    // A matter with room for some of the files takes them: the server refuses the others one by one.
    const { held, limit } = holding;
    if (limit !== -1 && held >= limit) {
      return failure(
        `Matter #${args.matter_id} holds ${held} of ${limit} documents; ` +
          "nothing can be added until some are removed on the matter page.",
      );
    }
    return await uploadPlanned(args, uploads, me, deps, { request, started });
  } catch (err) {
    return failureAfterSignIn(err, config.baseUrl, "Nothing was uploaded; try again in a moment.");
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
 * What a confirmed call does with the files its plan uploads: the native runtime when a PDF is
 * among them, then the uploads one at a time, each started with a line of progress. Between two
 * files, a call that was cancelled or has run past CALL_BUDGET_MS starts no more of them.
 */
async function uploadPlanned(
  args: UploadToMatterArgs,
  uploads: PlanEntry[],
  me: CurrentUser,
  deps: ToolDeps,
  call: { request: CallContext | undefined; started: number },
): Promise<CallToolResult> {
  const { config } = deps;
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
  const progress = progressOf(call.request);
  const outcomes: DocumentOutcome[] = [];
  for (const [i, entry] of uploads.entries()) {
    const stopped = i === 0 ? undefined : stopReason(call.request, deps.now() - call.started);
    if (stopped !== undefined) {
      outcomes.push({ name: entry.name, status: "skipped", ...stopped });
    } else if (entry.kind === "pdf" && runtimeFailure !== null) {
      outcomes.push({ name: entry.name, status: "failed", code: "native_runtime_unavailable", message: runtimeFailure });
    } else {
      progress?.(`Uploading ${entry.name} (${i + 1} of ${uploads.length})`);
      outcomes.push(await deps.upload(entry, ctx, progress));
    }
  }
  return report(args.matter_id, outcomes, deps);
}

/** Why the call starts no more files, `elapsed` milliseconds after it began; undefined when it goes on. */
function stopReason(request: CallContext | undefined, elapsed: number): { code: string; message: string } | undefined {
  if (request?.mcpReq.signal.aborted === true) return CANCELLED;
  if (elapsed > CALL_BUDGET_MS) return OVER_BUDGET;
  return undefined;
}

/**
 * A line of progress sent as the call's notifications/progress, numbered from 1, when its request
 * carries a progress token; undefined when it does not. A notification that cannot be sent is
 * dropped: it never stops an upload.
 */
function progressOf(request: CallContext | undefined): ((message: string) => void) | undefined {
  const progressToken = request?.mcpReq._meta?.progressToken;
  if (request === undefined || progressToken === undefined) return undefined;
  let progress = 0;
  return (message) => {
    progress += 1;
    const notification = { method: "notifications/progress", params: { progressToken, progress, message } };
    Promise.resolve()
      .then(() => request.mcpReq.notify(notification))
      .catch(() => {});
  };
}

/**
 * The outcomes, one line per file, then the matter's URL and the keychain warning when there is
 * one. A failure always says why: its code, when it came without a sentence.
 */
async function report(matterId: number, reported: DocumentOutcome[], deps: ToolDeps): Promise<CallToolResult> {
  const outcomes = reported.map((outcome) =>
    outcome.status === "failed" && outcome.message === undefined ? { ...outcome, message: outcome.code } : outcome,
  );
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
  return answer(lines.join("\n"), {
    status: "done",
    matter_id: matterId,
    matter_url: matterUrl,
    results,
    ...(warning === null ? {} : { warning }),
  });
}

/**
 * The plan: how to confirm it first, so that it is read before a long list; then a line per file it
 * uploads, a line for each of the first SHOWN_SKIPS files it skips and a count by reason of the
 * others, a line per named path without a file, and the matter with its documents.
 */
function listing(status: "confirmation_required" | "plan_changed", plan: UploadPlan, holding: Holding): CallToolResult {
  const uploads = plan.entries.filter((entry) => entry.decision === "upload");
  const skips = plan.entries.filter((entry): entry is Skipped => entry.decision === "skip" && entry.reason !== undefined);
  const shown = skips.slice(0, SHOWN_SKIPS);
  const { matterId, title, held, limit } = holding;
  const lines = [
    ...(status === "plan_changed" ? ["The files have changed since they were listed."] : []),
    `Nothing has been uploaded. Call again with confirm: true and plan_digest "${plan.digest}" ` +
      `to upload the ${uploads.length} file(s) marked upload.`,
    ...uploads.map(row),
    ...shown.map(row),
    ...[...countByReason(skips.slice(SHOWN_SKIPS))].map(
      ([reason, count]) => `… and ${count.toLocaleString("en-US")} more skipped (${reason})`,
    ),
    ...plan.emptyPaths.map((path) => `${path}: no eligible files`),
    `Matter #${matterId} "${title}": ${held} of ${limit === -1 ? "∞" : limit} documents`,
  ];
  return answer(lines.join("\n"), {
    status,
    plan_digest: plan.digest,
    files: uploads.map(({ name, sizeBytes, kind }) => ({ name, size_bytes: sizeBytes, type: kind })),
    skipped: {
      shown: shown.map(({ name, reason }) => ({ name, reason })),
      counts: Object.fromEntries(countByReason(skips)),
    },
    empty_paths: plan.emptyPaths,
    matter: { id: matterId, title, document_count: held, document_limit: limit === -1 ? null : limit },
  });
}

/** A plan entry that is skipped, with its reason. */
type Skipped = PlanEntry & { reason: SkipReason };

/** How many of `skips` each reason has, the reasons in the order they first come. */
function countByReason(skips: Skipped[]): Map<SkipReason, number> {
  const counts = new Map<SkipReason, number>();
  for (const { reason } of skips) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return counts;
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
