// handleUploadToMatter and handleCreateMatter against recording fakes: a session whose access token
// is "tok_secret" unless a test says otherwise, a plan resolver with a fixed plan, an API with canned
// answers, an upload that answers a fixed outcome per file, and a native runtime that installs unless
// a test makes it fail. `calls` lists the steps in the order they were taken. Every result goes
// through call(), which fails the test when the access token appears anywhere in it.

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import type * as z from "zod";
import type { CurrentUser, DikigorosApi, Matter, MatterDetail, MatterDocumentSummary } from "../api/client";
import { ApiError } from "../api/errors";
import { DeviceFlowError } from "../auth/device-flow";
import type { SignInPrompt } from "../auth/session";
import type { HelperConfig } from "../config";
import type { PlanEntry, UploadPlan } from "../files/resolve";
import type { DocumentOutcome, UploadContext } from "../pipeline/upload-document";
import {
  CALL_BUDGET_MS,
  type CallContext,
  type CreateMatterArgs,
  handleCreateMatter,
  handleUploadToMatter,
  registerTools,
  type ToolDeps,
  type UploadToMatterArgs,
} from "./tools";

const TOKEN = "tok_secret";

const CONFIG: HelperConfig = {
  baseUrl: "https://dikigoros.ai",
  audience: "https://dikigoros.ai/mcp",
  auth0Domain: "dikigoros-prod.eu.auth0.com",
  auth0ClientId: "client-123",
  scopes: "openid offline_access matters:read matters:write account:read",
  dataDir: "/Users/eleni/.dikigoros/helper",
  openBrowser: true,
  nativeDirOverride: null,
};

const PROMPT: SignInPrompt = {
  verificationUriComplete: "https://dikigoros-prod.eu.auth0.com/activate?user_code=QTZL-MCBW",
  verificationUri: "https://dikigoros-prod.eu.auth0.com/activate",
  userCode: "QTZL-MCBW",
  expiresInSeconds: 900,
};

const SIGN_IN: CallToolResult = {
  content: [
    {
      type: "text",
      text:
        "Sign in to DIKIGOROS first: open https://dikigoros-prod.eu.auth0.com/activate?user_code=QTZL-MCBW " +
        "and enter code QTZL-MCBW (valid 15 minutes). Then call this tool again.",
    },
  ],
  structuredContent: {
    status: "sign_in_required",
    verification_uri_complete: "https://dikigoros-prod.eu.auth0.com/activate?user_code=QTZL-MCBW",
    user_code: "QTZL-MCBW",
    expires_in_seconds: 900,
  },
};

const NOT_CONFIGURED = "The helper is not configured (DIKIGOROS_AUTH0_CLIENT_ID is empty).";
const STILL_PROCESSING = "still processing; the matter page resumes it, or call again later";
const DUPLICATE = "This file is already in the matter (document #12).";

const FOLDER = "/Users/eleni/Matters/Georgiou";
const EMPTY_FOLDER = "/Users/eleni/Matters/Empty";

const inFolder = (name: string) => ({ path: `${FOLDER}/${name}`, realPath: `${FOLDER}/${name}`, name });
const CLAIM: PlanEntry = { ...inFolder("claim.pdf"), sizeBytes: 48_213, kind: "pdf", decision: "upload" };
const DEFENCE: PlanEntry = { ...inFolder("υπεράσπιση.docx"), sizeBytes: 20_480, kind: "docx", decision: "upload" };
const PHOTO: PlanEntry = {
  ...inFolder("photo.jpg"),
  sizeBytes: 1_258_291,
  kind: null,
  decision: "skip",
  reason: "unsupported_type",
};
const NOTE: PlanEntry = { ...inFolder("σημείωμα.txt"), sizeBytes: 512, kind: "text", decision: "upload" };
const MISSING: PlanEntry = {
  path: "/Users/eleni/Desktop/missing.pdf",
  realPath: "",
  name: "missing.pdf",
  sizeBytes: 0,
  kind: null,
  decision: "skip",
  reason: "not_found",
};

const PATHS = [FOLDER, MISSING.path, EMPTY_FOLDER];
const PLAN: UploadPlan = {
  entries: [CLAIM, DEFENCE, PHOTO, NOTE, MISSING],
  digest: "3f2a9c0d1e4b5a67",
  emptyPaths: [EMPTY_FOLDER],
};

/** The digest sentence of a listing whose plan uploads `count` files. */
const confirmWith = (digest: string, count: number) =>
  `Nothing has been uploaded. Call again with confirm: true and plan_digest "${digest}" to upload the ${count} file(s) marked upload.`;

/** PLAN as the first call shows it, matter 7 holding 3 documents of the plan's 50. */
const LISTING = [
  confirmWith("3f2a9c0d1e4b5a67", 3),
  "claim.pdf · 47.1 KB · pdf · upload",
  "υπεράσπιση.docx · 20.0 KB · docx · upload",
  "σημείωμα.txt · 512 B · text · upload",
  "photo.jpg · 1.2 MB · — · skip (unsupported_type)",
  "missing.pdf · — · — · skip (not_found)",
  "/Users/eleni/Matters/Empty: no eligible files",
  'Matter #7 "Γεωργίου v Πέτρου": 3 of 50 documents',
].join("\n");

/** The files PLAN uploads, and what it skips. */
const FILES = [
  { name: "claim.pdf", size_bytes: 48_213, type: "pdf" },
  { name: "υπεράσπιση.docx", size_bytes: 20_480, type: "docx" },
  { name: "σημείωμα.txt", size_bytes: 512, type: "text" },
];
const SKIPPED = {
  shown: [
    { name: "photo.jpg", reason: "unsupported_type" },
    { name: "missing.pdf", reason: "not_found" },
  ],
  counts: { unsupported_type: 1, not_found: 1 },
};
const MATTER_FACTS = { id: 7, title: "Γεωργίου v Πέτρου", document_count: 3, document_limit: 50 };

/** PLAN's listing as structured content. */
const listed = (status: string) => ({
  status,
  plan_digest: "3f2a9c0d1e4b5a67",
  files: FILES,
  skipped: SKIPPED,
  empty_paths: [EMPTY_FOLDER],
  matter: MATTER_FACTS,
});

/** What the pipeline makes of each planned file. */
const OUTCOMES: Record<string, DocumentOutcome> = {
  "claim.pdf": { name: "claim.pdf", status: "ready", documentId: 31, pageCount: 2, ocrPages: 1, roleApplied: true },
  "υπεράσπιση.docx": { name: "υπεράσπιση.docx", status: "duplicate", documentId: 12, message: DUPLICATE },
  "σημείωμα.txt": {
    name: "σημείωμα.txt",
    status: "processing",
    documentId: 33,
    ocrRemaining: 0,
    message: STILL_PROCESSING,
    roleApplied: true,
  },
};

const DONE_TEXT = [
  "claim.pdf: ready",
  `υπεράσπιση.docx: duplicate — ${DUPLICATE}`,
  `σημείωμα.txt: processing — ${STILL_PROCESSING}`,
  "Matter #7: https://dikigoros.ai/matters/7",
].join("\n");

const RESULTS = [
  { name: "claim.pdf", status: "ready", doc_id: 31, page_count: 2, ocr_pages: 1, role_applied: true },
  { name: "υπεράσπιση.docx", status: "duplicate", doc_id: 12, message: DUPLICATE },
  {
    name: "σημείωμα.txt",
    status: "processing",
    doc_id: 33,
    ocr_remaining: 0,
    message: STILL_PROCESSING,
    role_applied: true,
  },
];

const ME: CurrentUser = {
  id: 42,
  email: "eleni@example.com",
  plan: "firm",
  entitlements: { mattersAccess: true, docsPerMatter: 50, activeMatters: 20, tier: "firm" },
};

const MATTER: Matter = {
  id: 7,
  userId: 42,
  title: "Γεωργίου v Πέτρου",
  caseReference: "Αγωγή 112/2026",
  matterType: "civil",
  description: "",
  status: "active",
  deletedAt: null,
  createdAt: "2026-10-01T09:00:00.000Z",
  updatedAt: "2026-10-18T09:00:00.000Z",
};

/** POST /api/matters: the matter create_matter opened. */
const CREATED: Matter = {
  ...MATTER,
  id: 9,
  title: "Κυριάκου v Δήμου Λευκωσίας",
  caseReference: "Αίτηση 45/2026",
  matterType: "interim_application",
  description: "Αίτηση για προσωρινό διάταγμα",
};

const DOCUMENT: MatterDocumentSummary = {
  id: 100,
  filename: "earlier.pdf",
  role: null,
  side: null,
  roleConfirmed: false,
  guide: null,
  origin: "upload",
  ingestStatus: "ready",
  pageCount: 3,
  ocrApplied: false,
  sizeBytes: 1000,
  createdAt: "2026-10-02T09:00:00.000Z",
};

/** GET /api/matters/7 for a matter that already holds `count` documents. */
function matterHolding(count: number): MatterDetail {
  const documents = Array.from({ length: count }, (_, i) => ({ ...DOCUMENT, id: 100 + i }));
  return { matter: MATTER, documents, pins: [], notes: [], artifacts: [] };
}

interface Setup {
  /** What getAccessToken answers: TOKEN unless given, null when nobody is signed in, an Error to reject. */
  token?: string | null | Error;
  signIn?: SignInPrompt | Error;
  plan?: UploadPlan;
  me?: CurrentUser | Error;
  matter?: MatterDetail | Error;
  /** Why the native runtime cannot be installed; it installs unless given. */
  runtime?: Error;
  warning?: string;
  created?: Matter | Error;
  config?: Partial<HelperConfig>;
}

/** `value`, thrown instead when it is an Error: how a fake rejects. */
function unwrap<T>(value: T): Exclude<T, Error> {
  if (value instanceof Error) throw value;
  return value as Exclude<T, Error>;
}

function fakes(setup: Setup = {}) {
  const calls: string[] = [];
  const step = <T>(label: string, value: T) => {
    calls.push(label);
    return unwrap(value);
  };
  const session = {
    getAccessToken: vi.fn(async () => step("getAccessToken", setup.token === undefined ? TOKEN : setup.token)),
    beginSignIn: vi.fn(async () => step("beginSignIn", setup.signIn ?? PROMPT)),
    forgetSession: vi.fn(async () => step("forgetSession", undefined)),
  };
  const api = {
    currentUser: vi.fn<DikigorosApi["currentUser"]>(async () => step("currentUser", setup.me ?? ME)),
    getMatter: vi.fn<DikigorosApi["getMatter"]>(async (id) => step(`getMatter(${id})`, setup.matter ?? matterHolding(3))),
    createMatter: vi.fn<DikigorosApi["createMatter"]>(async () => step("createMatter", setup.created ?? CREATED)),
  };
  const resolvePlan = vi.fn<ToolDeps["resolvePlan"]>(async () => step("resolvePlan", setup.plan ?? PLAN));
  const upload = vi.fn<ToolDeps["upload"]>(async (entry) => step(`upload(${entry.name})`, OUTCOMES[entry.name]));
  const nodeModules = { nodeModulesDir: "/Users/eleni/.dikigoros/helper/native/0f3c8a1b2d4e/node_modules" };
  const nativeRuntime = vi.fn<ToolDeps["nativeRuntime"]>(async () => step("nativeRuntime", setup.runtime ?? nodeModules));
  /** The time the handler reads: it stands still unless a test moves it. */
  const clock = { now: 1_760_870_400_000 };
  const deps: ToolDeps = {
    config: { ...CONFIG, ...setup.config },
    session,
    api: api as unknown as DikigorosApi,
    resolvePlan,
    upload,
    nativeRuntime,
    tokenStoreWarning: async () => setup.warning ?? null,
    now: () => clock.now,
  };
  return { deps, calls, session, api, resolvePlan, upload, nativeRuntime, clock };
}

/**
 * The part of the SDK's request context the handler reads: a signal, aborted when `aborted`, the
 * request's `_meta` with `progressToken` when one is given, and a notify that records what it sends.
 */
function requestContext({ aborted = false, progressToken }: { aborted?: boolean; progressToken?: string | number } = {}) {
  const controller = new AbortController();
  if (aborted) controller.abort();
  const notify = vi.fn<CallContext["mcpReq"]["notify"]>(async () => {});
  const ctx: CallContext = {
    mcpReq: {
      signal: controller.signal,
      _meta: progressToken === undefined ? undefined : { progressToken },
      notify,
    },
  };
  return { ctx, notify, controller };
}

/** The handler's result, checked on its way out for the session's access token. */
async function call<A>(
  handler: (args: A, deps: ToolDeps) => Promise<CallToolResult>,
  args: A,
  deps: ToolDeps,
): Promise<CallToolResult> {
  const result = await handler(args, deps);
  expect(JSON.stringify(result)).not.toContain(TOKEN);
  return result;
}

/** The text of a result made of one text block. */
function textOf(result: CallToolResult): string {
  expect(result.content).toHaveLength(1);
  const [block] = result.content;
  if (block.type !== "text") throw new Error(`expected a text block, got ${block.type}`);
  return block.text;
}

const errorResult = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

describe.each([
  {
    tool: "upload_to_matter",
    run: (deps: ToolDeps) => call(handleUploadToMatter, { matter_id: 7, paths: PATHS }, deps),
  },
  {
    tool: "create_matter",
    run: (deps: ToolDeps) => call(handleCreateMatter, { title: "Κυριάκου v Δήμου Λευκωσίας" }, deps),
  },
])("$tool, before anything else", ({ run }) => {
  it("refuses to run while DIKIGOROS_AUTH0_CLIENT_ID is empty", async () => {
    const f = fakes({ config: { auth0ClientId: "" } });
    expect(await run(f.deps)).toStrictEqual(errorResult(NOT_CONFIGURED));
    expect(f.calls).toEqual([]);
  });

  it("starts a sign-in when nobody is signed in, and answers with its prompt", async () => {
    const f = fakes({ token: null });
    expect(await run(f.deps)).toStrictEqual(SIGN_IN);
    expect(f.session.beginSignIn).toHaveBeenCalledTimes(1);
    expect(f.calls).toEqual(["getAccessToken", "beginSignIn"]);
  });

  it("gives the code's lifetime in whole minutes, rounded down", async () => {
    const f = fakes({ token: null, signIn: { ...PROMPT, expiresInSeconds: 599 } });
    expect(textOf(await run(f.deps))).toContain("(valid 9 minutes)");
  });

  it("changes nothing and starts no sign-in when the sign-in cannot be read or refreshed", async () => {
    const keychain = new Error("Platform secure storage failure: User interaction is not allowed.\nRequire stack:\n- …");
    const f = fakes({ token: keychain });
    expect(await run(f.deps)).toStrictEqual(
      errorResult(
        "Could not reach the sign-in service (Platform secure storage failure: User interaction is not allowed.). " +
          "Nothing was changed; try again in a moment.",
      ),
    );
    expect(f.calls).toEqual(["getAccessToken"]);
  });

  it("says the same when the sign-in service does not answer the start of a sign-in", async () => {
    const f = fakes({ token: null, signIn: new TypeError("fetch failed") });
    expect(await run(f.deps)).toStrictEqual(
      errorResult("Could not reach the sign-in service (fetch failed). Nothing was changed; try again in a moment."),
    );
    expect(f.calls).toEqual(["getAccessToken", "beginSignIn"]);
  });
});

describe("upload_to_matter: the listing", () => {
  it.each([
    { what: "without confirm", confirm: undefined },
    { what: "with confirm: false", confirm: false },
    { what: "with confirm: true but no plan_digest", confirm: true },
  ])("lists what would be uploaded and uploads nothing, $what", async ({ confirm }) => {
    const f = fakes();
    const result = await call(handleUploadToMatter, { matter_id: 7, paths: PATHS, confirm }, f.deps);

    expect(result).toEqual({
      content: [{ type: "text", text: LISTING }],
      structuredContent: listed("confirmation_required"),
    });
    expect(result.isError).toBeUndefined();
    expect(f.resolvePlan.mock.calls).toEqual([[PATHS]]);
    // The account and the matter first, so that a matter that is not there is said before any list.
    expect(f.calls).toEqual(["getAccessToken", "currentUser", "getMatter(7)", "resolvePlan"]);
    expect(f.upload).not.toHaveBeenCalled();
  });

  it("lists the files again, uploading nothing, when they changed since the listing confirmed", async () => {
    const f = fakes();
    const args: UploadToMatterArgs = { matter_id: 7, paths: PATHS, confirm: true, plan_digest: "0f0f0f0f0f0f0f0f" };
    const result = await call(handleUploadToMatter, args, f.deps);

    expect(result).toEqual({
      content: [{ type: "text", text: `The files have changed since they were listed.\n${LISTING}` }],
      structuredContent: listed("plan_changed"),
    });
    expect(result.isError).toBeUndefined();
    expect(f.calls).toEqual(["getAccessToken", "currentUser", "getMatter(7)", "resolvePlan"]);
    expect(f.upload).not.toHaveBeenCalled();
  });

  it("gives a plan without a limit of documents per matter as ∞", async () => {
    const me = { ...ME, entitlements: { ...ME.entitlements, docsPerMatter: -1 } };
    const f = fakes({ me, matter: matterHolding(900) });
    const result = await call(handleUploadToMatter, { matter_id: 7, paths: PATHS }, f.deps);

    expect(textOf(result).split("\n").at(-1)).toBe('Matter #7 "Γεωργίου v Πέτρου": 900 of ∞ documents');
    expect(result.structuredContent).toMatchObject({
      matter: { ...MATTER_FACTS, document_count: 900, document_limit: null },
    });
  });

  it("names the files it uploads, at most 25 that it skips, and counts the rest of those by reason", async () => {
    // A Downloads folder: 2,700 photos, 100 PDFs that fill the plan, and 200 more the cap leaves unseen.
    const photos = Array.from({ length: 2700 }, (_, i): PlanEntry => ({
      ...inFolder(`IMG_${String(i).padStart(4, "0")}.jpg`),
      sizeBytes: 2_400_000,
      kind: null,
      decision: "skip",
      reason: "unsupported_type",
    }));
    const pdfs = Array.from({ length: 100 }, (_, i): PlanEntry => ({
      ...inFolder(`scan-${String(i).padStart(3, "0")}.pdf`),
      sizeBytes: 48_213,
      kind: "pdf",
      decision: "upload",
    }));
    const capped = Array.from({ length: 200 }, (_, i): PlanEntry => ({
      ...inFolder(`scan-${String(100 + i).padStart(3, "0")}.pdf`),
      realPath: "",
      sizeBytes: 0,
      kind: null,
      decision: "skip",
      reason: "too_many_files",
    }));
    const plan: UploadPlan = { entries: [...photos, ...pdfs, ...capped], digest: "9c41d0e2b7a35f86", emptyPaths: [] };
    const f = fakes({ plan });
    const result = await call(handleUploadToMatter, { matter_id: 7, paths: [FOLDER] }, f.deps);

    const lines = textOf(result).split("\n");
    expect(lines[0]).toBe(confirmWith("9c41d0e2b7a35f86", 100));
    expect(lines.slice(1, 101)).toEqual(pdfs.map(({ name }) => `${name} · 47.1 KB · pdf · upload`));
    expect(lines.slice(101, 126)).toEqual(photos.slice(0, 25).map(({ name }) => `${name} · 2.3 MB · — · skip (unsupported_type)`));
    expect(lines.slice(126)).toEqual([
      "… and 2,675 more skipped (unsupported_type)",
      "… and 200 more skipped (too_many_files)",
      'Matter #7 "Γεωργίου v Πέτρου": 3 of 50 documents',
    ]);
    expect(result.structuredContent).toEqual({
      status: "confirmation_required",
      plan_digest: "9c41d0e2b7a35f86",
      files: pdfs.map(({ name }) => ({ name, size_bytes: 48_213, type: "pdf" })),
      skipped: {
        shown: photos.slice(0, 25).map(({ name }) => ({ name, reason: "unsupported_type" })),
        counts: { unsupported_type: 2700, too_many_files: 200 },
      },
      empty_paths: [],
      matter: MATTER_FACTS,
    });
  });

  it("has nothing to upload when the confirmed plan skips every file", async () => {
    const f = fakes({ plan: { entries: [PHOTO, MISSING], digest: "e3b0c44298fc1c14", emptyPaths: [] } });
    const args: UploadToMatterArgs = { matter_id: 7, paths: PATHS, confirm: true, plan_digest: "e3b0c44298fc1c14" };
    const result = await call(handleUploadToMatter, args, f.deps);

    expect(result).toStrictEqual({ content: [{ type: "text", text: "Nothing to upload." }] });
    expect(f.calls).toEqual(["getAccessToken", "currentUser", "getMatter(7)", "resolvePlan"]);
  });
});

describe.each([
  { call: "the listing", args: { matter_id: 7, paths: PATHS } satisfies UploadToMatterArgs },
  {
    call: "the confirmed call",
    args: { matter_id: 7, paths: PATHS, confirm: true, plan_digest: "3f2a9c0d1e4b5a67" } satisfies UploadToMatterArgs,
  },
])("upload_to_matter: the account and the matter, on $call", ({ args }) => {
  it("answers with the plan sentence when the account's plan has no Matters", async () => {
    const f = fakes({ me: { ...ME, entitlements: { ...ME.entitlements, mattersAccess: false } } });
    const result = await call(handleUploadToMatter, args, f.deps);

    expect(result).toStrictEqual(errorResult("This needs the Firm plan (Matters). Plans: https://dikigoros.ai/pricing"));
    expect(f.calls).toEqual(["getAccessToken", "currentUser"]);
  });

  it("forgets a session the current-user route refuses, and answers with a new sign-in's prompt", async () => {
    const f = fakes({ me: new ApiError(401, "Authentication required") });
    const result = await call(handleUploadToMatter, args, f.deps);

    expect(result).toStrictEqual(SIGN_IN);
    expect(f.calls).toEqual(["getAccessToken", "currentUser", "forgetSession", "beginSignIn"]);
  });

  it("keeps the session on any other refusal of the current-user route, and answers with its sentence", async () => {
    const f = fakes({ me: new ApiError(403, "account_suspended") });
    const result = await call(handleUploadToMatter, args, f.deps);

    expect(result).toStrictEqual(errorResult("This DIKIGOROS account has been suspended."));
    expect(f.calls).toEqual(["getAccessToken", "currentUser"]);
  });

  it("answers with the API's sentence, before reading any file, when the matter is not the lawyer's", async () => {
    const f = fakes({ matter: new ApiError(404, "Not found") });
    const result = await call(handleUploadToMatter, args, f.deps);

    expect(result).toStrictEqual(errorResult("Matter not found (or not yours)."));
    expect(f.calls).toEqual(["getAccessToken", "currentUser", "getMatter(7)"]);
  });

  it.each([
    { what: "the current-user request gets no answer", setup: { me: new TypeError("fetch failed") }, line: "fetch failed" },
    {
      what: "the matter's address does not resolve",
      setup: { matter: new Error("getaddrinfo ENOTFOUND dikigoros.ai\n    at GetAddrInfoReqWrap.onlookupall (node:dns:120:26)") },
      line: "getaddrinfo ENOTFOUND dikigoros.ai",
    },
    {
      what: "the sign-in service fails the refresh after a 401",
      setup: { matter: new DeviceFlowError("http_503", "http_503", 503) },
      line: "http_503",
    },
  ])("says DIKIGOROS could not be reached, and nothing was uploaded, when $what", async ({ setup, line }) => {
    const f = fakes(setup);
    const result = await call(handleUploadToMatter, args, f.deps);

    expect(result).toStrictEqual(
      errorResult(`Could not reach DIKIGOROS (${line}). Nothing was uploaded; try again in a moment.`),
    );
    expect(f.resolvePlan).not.toHaveBeenCalled();
    expect(f.upload).not.toHaveBeenCalled();
    expect(f.session.forgetSession).not.toHaveBeenCalled();
  });
});

describe("upload_to_matter: the confirmed call", () => {
  const CONFIRMED: UploadToMatterArgs = {
    matter_id: 7,
    paths: PATHS,
    role: "exhibit",
    side: "ours",
    confirm: true,
    plan_digest: "3f2a9c0d1e4b5a67",
  };
  const CTX: UploadContext = { baseUrl: "https://dikigoros.ai", userId: 42, matterId: 7, role: "exhibit", side: "ours" };

  it("checks the account and the matter, then uploads each planned file in order and reports it", async () => {
    const f = fakes();
    const result = await call(handleUploadToMatter, CONFIRMED, f.deps);

    expect(f.calls).toEqual([
      "getAccessToken",
      "currentUser",
      "getMatter(7)",
      "resolvePlan",
      "nativeRuntime",
      "upload(claim.pdf)",
      "upload(υπεράσπιση.docx)",
      "upload(σημείωμα.txt)",
    ]);
    expect(f.upload.mock.calls.map(([entry, ctx]) => [entry, ctx])).toEqual([
      [CLAIM, CTX],
      [DEFENCE, CTX],
      [NOTE, CTX],
    ]);
    expect(result).toEqual({
      content: [{ type: "text", text: DONE_TEXT }],
      structuredContent: { status: "done", matter_id: 7, matter_url: "https://dikigoros.ai/matters/7", results: RESULTS },
    });
    expect(result.isError).toBeUndefined();
  });

  it("uploads one file at a time", async () => {
    const f = fakes();
    let inFlight = 0;
    let most = 0;
    f.upload.mockImplementation(async (entry) => {
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return OUTCOMES[entry.name];
    });
    await call(handleUploadToMatter, CONFIRMED, f.deps);

    expect(f.upload).toHaveBeenCalledTimes(3);
    expect(most).toBe(1);
  });

  it("gives the uploads no role or side when the call names none", async () => {
    const f = fakes();
    const args: UploadToMatterArgs = { matter_id: 7, paths: PATHS, confirm: true, plan_digest: PLAN.digest };
    const result = await call(handleUploadToMatter, args, f.deps);

    expect(f.upload.mock.calls.map(([entry, ctx]) => [entry.name, ctx])).toEqual([
      ["claim.pdf", { baseUrl: "https://dikigoros.ai", userId: 42, matterId: 7 }],
      ["υπεράσπιση.docx", { baseUrl: "https://dikigoros.ai", userId: 42, matterId: 7 }],
      ["σημείωμα.txt", { baseUrl: "https://dikigoros.ai", userId: 42, matterId: 7 }],
    ]);
    expect(textOf(result)).toBe(DONE_TEXT);
  });

  it("gives a failed file without a sentence its code as the reason", async () => {
    const f = fakes();
    f.upload.mockImplementation(async (entry) =>
      entry.name === "claim.pdf" ? { name: "claim.pdf", status: "failed", documentId: 31, code: "processing_failed" } : OUTCOMES[entry.name],
    );
    const result = await call(handleUploadToMatter, CONFIRMED, f.deps);

    expect(textOf(result).split("\n")[0]).toBe("claim.pdf: failed — processing_failed");
    expect(result.structuredContent).toMatchObject({
      results: [{ name: "claim.pdf", status: "failed", doc_id: 31, code: "processing_failed", message: "processing_failed" }, {}, {}],
    });
  });

  it("appends the keychain warning once, after the matter's URL", async () => {
    const warning =
      "The OS keychain is not available on this machine (Download failed for @napi-rs/keyring: fetch failed); " +
      "the sign-in is kept in memory for this session only.";
    const f = fakes({ warning });
    const result = await call(handleUploadToMatter, CONFIRMED, f.deps);

    expect(textOf(result)).toBe(`${DONE_TEXT}\n${warning}`);
    expect(result.structuredContent).toEqual({
      status: "done",
      matter_id: 7,
      matter_url: "https://dikigoros.ai/matters/7",
      results: RESULTS,
      warning,
    });
  });

  it("has no warning in its structured content when the keychain works", async () => {
    const result = await call(handleUploadToMatter, CONFIRMED, fakes().deps);
    expect(result.structuredContent).not.toHaveProperty("warning");
  });

  it.each([
    { held: 50, what: "full" },
    { held: 52, what: "over its limit, the plan having changed" },
  ])("uploads nothing into a matter that is $what", async ({ held }) => {
    const f = fakes({ matter: matterHolding(held) });
    const result = await call(handleUploadToMatter, CONFIRMED, f.deps);

    expect(result).toStrictEqual(
      errorResult(
        `Matter #7 holds ${held} of 50 documents; nothing can be added until some are removed on the matter page.`,
      ),
    );
    expect(f.calls).toEqual(["getAccessToken", "currentUser", "getMatter(7)", "resolvePlan"]);
  });

  it("uploads into a matter with room for some of the files, each refused file reported on its own", async () => {
    const f = fakes({ matter: matterHolding(48) });
    const full: DocumentOutcome = {
      name: "σημείωμα.txt",
      status: "failed",
      code: "document_limit_reached",
      message: "Document limit reached (50 per matter).",
    };
    f.upload.mockImplementation(async (entry) => (entry.name === full.name ? full : OUTCOMES[entry.name]));
    const result = await call(handleUploadToMatter, CONFIRMED, f.deps);

    expect(f.upload).toHaveBeenCalledTimes(3);
    expect(textOf(result).split("\n")[2]).toBe("σημείωμα.txt: failed — Document limit reached (50 per matter).");
  });

  it.each([
    { held: 47, limit: 50 },
    { held: 900, limit: -1 },
  ])("uploads when $held documents and the 3 planned fit a limit of $limit", async ({ held, limit }) => {
    const me = { ...ME, entitlements: { ...ME.entitlements, docsPerMatter: limit } };
    const f = fakes({ me, matter: matterHolding(held) });
    const result = await call(handleUploadToMatter, CONFIRMED, f.deps);

    expect(f.upload).toHaveBeenCalledTimes(3);
    expect(textOf(result)).toBe(DONE_TEXT);
  });
});

describe("upload_to_matter: the native runtime", () => {
  const SCAN: PlanEntry = { ...inFolder("scan.pdf"), sizeBytes: 2_097_152, kind: "pdf", decision: "upload" };
  const WITH_TWO_PDFS: UploadPlan = { entries: [CLAIM, DEFENCE, SCAN], digest: "7d1c5e9a0b3f2468", emptyPaths: [] };

  it("is installed once, before any upload, and when it cannot be the PDFs alone fail", async () => {
    const failure = new Error("Download failed for @napi-rs/canvas: fetch failed\n    at download (install.ts:120)");
    const f = fakes({ plan: WITH_TWO_PDFS, runtime: failure });
    const args: UploadToMatterArgs = { matter_id: 7, paths: [FOLDER], confirm: true, plan_digest: WITH_TWO_PDFS.digest };
    const result = await call(handleUploadToMatter, args, f.deps);

    expect(f.calls).toEqual([
      "getAccessToken",
      "currentUser",
      "getMatter(7)",
      "resolvePlan",
      "nativeRuntime",
      "upload(υπεράσπιση.docx)",
    ]);
    const unavailable = (name: string) => ({
      name,
      status: "failed",
      code: "native_runtime_unavailable",
      message: "Download failed for @napi-rs/canvas: fetch failed",
    });
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: [
            "claim.pdf: failed — Download failed for @napi-rs/canvas: fetch failed",
            `υπεράσπιση.docx: duplicate — ${DUPLICATE}`,
            "scan.pdf: failed — Download failed for @napi-rs/canvas: fetch failed",
            "Matter #7: https://dikigoros.ai/matters/7",
          ].join("\n"),
        },
      ],
      structuredContent: {
        status: "done",
        matter_id: 7,
        matter_url: "https://dikigoros.ai/matters/7",
        results: [unavailable("claim.pdf"), RESULTS[1], unavailable("scan.pdf")],
      },
    });
  });

  it("is not installed for a plan without a PDF", async () => {
    const f = fakes({ plan: { entries: [DEFENCE, NOTE], digest: "a1b2c3d4e5f60718", emptyPaths: [] } });
    const args: UploadToMatterArgs = { matter_id: 7, paths: [FOLDER], confirm: true, plan_digest: "a1b2c3d4e5f60718" };
    await call(handleUploadToMatter, args, f.deps);

    expect(f.nativeRuntime).not.toHaveBeenCalled();
    expect(f.calls).toEqual([
      "getAccessToken",
      "currentUser",
      "getMatter(7)",
      "resolvePlan",
      "upload(υπεράσπιση.docx)",
      "upload(σημείωμα.txt)",
    ]);
  });
});

describe("upload_to_matter: a long call", () => {
  const CONFIRMED: UploadToMatterArgs = { matter_id: 7, paths: PATHS, confirm: true, plan_digest: PLAN.digest };
  const CANCELLED = "not started: the call was cancelled";
  const OVER_BUDGET =
    "not started: this call ran over 20 minutes; call again — files already uploaded are picked up as duplicates or resumed";

  it("starts no file after the first once the call is cancelled: the others are skipped (cancelled)", async () => {
    const f = fakes();
    const { ctx } = requestContext({ aborted: true });
    const result = await handleUploadToMatter(CONFIRMED, f.deps, ctx);

    expect(f.upload.mock.calls.map(([entry]) => entry.name)).toEqual(["claim.pdf"]);
    expect(textOf(result)).toBe(
      [
        "claim.pdf: ready",
        `υπεράσπιση.docx: skipped — ${CANCELLED}`,
        `σημείωμα.txt: skipped — ${CANCELLED}`,
        "Matter #7: https://dikigoros.ai/matters/7",
      ].join("\n"),
    );
    expect(result.structuredContent).toMatchObject({
      results: [
        RESULTS[0],
        { name: "υπεράσπιση.docx", status: "skipped", code: "cancelled", message: CANCELLED },
        { name: "σημείωμα.txt", status: "skipped", code: "cancelled", message: CANCELLED },
      ],
    });
  });

  it(`starts no file once the call has run more than CALL_BUDGET_MS (${CALL_BUDGET_MS} ms): the others are skipped (call_budget)`, async () => {
    const f = fakes();
    f.upload.mockImplementation(async (entry) => {
      // The first file takes the whole budget, which is not yet over; the second one more millisecond.
      f.clock.now += entry.name === "claim.pdf" ? CALL_BUDGET_MS : 1;
      return OUTCOMES[entry.name];
    });
    const result = await call(handleUploadToMatter, CONFIRMED, f.deps);

    expect(f.upload.mock.calls.map(([entry]) => entry.name)).toEqual(["claim.pdf", "υπεράσπιση.docx"]);
    expect(textOf(result).split("\n")[2]).toBe(`σημείωμα.txt: skipped — ${OVER_BUDGET}`);
    expect(result.structuredContent).toMatchObject({
      results: [RESULTS[0], RESULTS[1], { name: "σημείωμα.txt", status: "skipped", code: "call_budget", message: OVER_BUDGET }],
    });
  });

  it("reports each file it starts and each OCR count as progress, when the request carries a progress token", async () => {
    const f = fakes();
    f.upload.mockImplementation(async (entry, _ctx, onProgress) => {
      if (entry.name === "claim.pdf") {
        onProgress?.("claim.pdf: OCR, 2 page(s) remaining");
        onProgress?.("claim.pdf: finalizing");
      }
      return OUTCOMES[entry.name];
    });
    const { ctx, notify } = requestContext({ progressToken: "upload-7" });
    const result = await handleUploadToMatter(CONFIRMED, f.deps, ctx);

    expect(textOf(result)).toBe(DONE_TEXT);
    expect(notify.mock.calls.map(([notification]) => notification)).toEqual(
      [
        "Uploading claim.pdf (1 of 3)",
        "claim.pdf: OCR, 2 page(s) remaining",
        "claim.pdf: finalizing",
        "Uploading υπεράσπιση.docx (2 of 3)",
        "Uploading σημείωμα.txt (3 of 3)",
      ].map((message, i) => ({
        method: "notifications/progress",
        params: { progressToken: "upload-7", progress: i + 1, message },
      })),
    );
  });

  it("sends no progress without a progress token, and uploads all the same when a notification cannot be sent", async () => {
    const quiet = fakes();
    const { ctx: withoutToken, notify: unused } = requestContext();
    await handleUploadToMatter(CONFIRMED, quiet.deps, withoutToken);
    expect(unused).not.toHaveBeenCalled();
    expect(quiet.upload.mock.calls.map(([, , onProgress]) => onProgress)).toEqual([undefined, undefined, undefined]);

    const f = fakes();
    const { ctx, notify } = requestContext({ progressToken: 7 });
    notify.mockRejectedValue(new Error("Not connected"));
    const result = await handleUploadToMatter(CONFIRMED, f.deps, ctx);
    expect(notify).toHaveBeenCalledTimes(3);
    expect(textOf(result)).toBe(DONE_TEXT);
  });
});

describe("create_matter", () => {
  it("opens the matter, type as matterType and case_reference as caseReference", async () => {
    const f = fakes();
    const args: CreateMatterArgs = {
      title: "Κυριάκου v Δήμου Λευκωσίας",
      type: "interim_application",
      case_reference: "Αίτηση 45/2026",
      description: "Αίτηση για προσωρινό διάταγμα",
    };
    const result = await call(handleCreateMatter, args, f.deps);

    expect(f.api.createMatter.mock.calls).toEqual([
      [
        {
          title: "Κυριάκου v Δήμου Λευκωσίας",
          matterType: "interim_application",
          caseReference: "Αίτηση 45/2026",
          description: "Αίτηση για προσωρινό διάταγμα",
        },
      ],
    ]);
    expect(result).toEqual({
      content: [{ type: "text", text: 'Created matter #9 "Κυριάκου v Δήμου Λευκωσίας" — https://dikigoros.ai/matters/9' }],
      structuredContent: {
        matter: {
          id: 9,
          title: "Κυριάκου v Δήμου Λευκωσίας",
          matter_type: "interim_application",
          case_reference: "Αίτηση 45/2026",
          status: "active",
          url: "https://dikigoros.ai/matters/9",
        },
      },
    });
    expect(result.isError).toBeUndefined();
    expect(f.calls).toEqual(["getAccessToken", "createMatter"]);
  });

  it("answers with the API's sentence when the matter cannot be opened", async () => {
    const f = fakes({ created: new ApiError(429, "matter_limit_reached", { limit: 10 }) });
    const result = await call(handleCreateMatter, { title: "Κυριάκου v Δήμου Λευκωσίας" }, f.deps);

    expect(result).toStrictEqual(errorResult("Matter limit reached (10 active matters)."));
  });

  it("forgets a session the server refuses, and answers with a new sign-in's prompt", async () => {
    const f = fakes({ created: new ApiError(401, "Authentication required") });
    const result = await call(handleCreateMatter, { title: "Κυριάκου v Δήμου Λευκωσίας" }, f.deps);

    expect(result).toStrictEqual(SIGN_IN);
    expect(f.calls).toEqual(["getAccessToken", "createMatter", "forgetSession", "beginSignIn"]);
  });

  it("keeps the session when there was no token to send, and asks for the call once more", async () => {
    const f = fakes({ created: new ApiError(401, "not_signed_in") });
    const result = await call(handleCreateMatter, { title: "Κυριάκου v Δήμου Λευκωσίας" }, f.deps);

    expect(result).toStrictEqual(
      errorResult("Sign in again: call the tool once more and follow the sign-in instructions."),
    );
    expect(f.calls).toEqual(["getAccessToken", "createMatter"]);
  });

  it("says the matter may not have been opened when DIKIGOROS could not be reached", async () => {
    const f = fakes({ created: new TypeError("fetch failed") });
    const result = await call(handleCreateMatter, { title: "Κυριάκου v Δήμου Λευκωσίας" }, f.deps);

    expect(result).toStrictEqual(
      errorResult(
        "Could not reach DIKIGOROS (fetch failed). The matter may not have been created; " +
          "check https://dikigoros.ai/matters before trying again.",
      ),
    );
  });
});

describe("the access token", () => {
  it("is never part of a result, though the session hands it out", async () => {
    const f = fakes();
    const results = [
      await handleUploadToMatter({ matter_id: 7, paths: PATHS }, f.deps),
      await handleUploadToMatter({ matter_id: 7, paths: PATHS, confirm: true, plan_digest: PLAN.digest }, f.deps),
      await handleCreateMatter({ title: "Κυριάκου v Δήμου Λευκωσίας" }, f.deps),
    ];

    await expect(f.session.getAccessToken.mock.results[0].value).resolves.toBe(TOKEN);
    for (const result of results) expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe("registerTools", () => {
  const UPLOAD_DESCRIPTION =
    "Use this when the lawyer asks to add files from this computer to a DIKIGOROS matter. Takes absolute paths " +
    "to .pdf, .docx, .txt or .md files, or to a folder (its top-level files). The first call lists what would be " +
    "uploaded and uploads nothing; call again with confirm: true and the plan_digest from that answer to upload. " +
    "Not for files already in the matter, other file types, or for searching or reading matter documents.";
  const CREATE_DESCRIPTION =
    "Use this when the lawyer asks to open a new matter in DIKIGOROS, for example before uploading files to it. " +
    "Creates the matter with a title and optional type, case reference and description. Not for changing, " +
    "archiving or deleting an existing matter.";

  interface Registered {
    config: { title: string; description: string; inputSchema: z.ZodType; annotations: Record<string, boolean> };
    callback: (args: unknown, ctx?: CallContext) => Promise<CallToolResult>;
  }

  /** The tools registerTools puts on a stand-in server, answering with `deps`. */
  function registered(deps: ToolDeps = fakes().deps): Map<string, Registered> {
    const tools = new Map<string, Registered>();
    const server = {
      registerTool(name: string, config: Registered["config"], callback: Registered["callback"]) {
        tools.set(name, { config, callback });
      },
    };
    registerTools(server as unknown as McpServer, deps);
    return tools;
  }

  const schemaOf = (name: string) => registered().get(name)!.config.inputSchema;

  it("registers upload_to_matter and create_matter, nothing else", () => {
    expect([...registered().keys()]).toEqual(["upload_to_matter", "create_matter"]);
  });

  it.each([
    { name: "upload_to_matter", title: "Upload files to a matter", description: UPLOAD_DESCRIPTION },
    { name: "create_matter", title: "Create a matter", description: CREATE_DESCRIPTION },
  ])("gives $name its title, description and annotations", ({ name, title, description }) => {
    const { config } = registered().get(name)!;
    expect(config.title).toBe(title);
    expect(config.description).toBe(description);
    expect(config.annotations).toStrictEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("answers each tool's calls with its own handler", async () => {
    const tools = registered();
    const listing = await tools.get("upload_to_matter")!.callback({ matter_id: 7, paths: PATHS });
    const created = await tools.get("create_matter")!.callback({ title: "Κυριάκου v Δήμου Λευκωσίας" });

    expect(textOf(listing)).toBe(LISTING);
    expect(textOf(created)).toBe('Created matter #9 "Κυριάκου v Δήμου Λευκωσίας" — https://dikigoros.ai/matters/9');
  });

  it("hands upload_to_matter the request's context: its signal and its progress token", async () => {
    const f = fakes();
    const { ctx, notify } = requestContext({ aborted: true, progressToken: "p" });
    const args = { matter_id: 7, paths: PATHS, confirm: true, plan_digest: PLAN.digest };
    await registered(f.deps).get("upload_to_matter")!.callback(args, ctx);

    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls).toEqual([
      [{ method: "notifications/progress", params: { progressToken: "p", progress: 1, message: "Uploading claim.pdf (1 of 3)" } }],
    ]);
  });

  it("takes for upload_to_matter a matter id and 1 to 50 paths, with an optional role, side, confirm and digest", () => {
    const schema = schemaOf("upload_to_matter");
    const fifty = Array.from({ length: 50 }, () => FOLDER);
    expect(schema.safeParse({ matter_id: 7, paths: [FOLDER] }).success).toBe(true);
    expect(
      schema.safeParse({ matter_id: 7, paths: fifty, role: "exhibit", side: "theirs", confirm: true, plan_digest: PLAN.digest })
        .success,
    ).toBe(true);
  });

  it.each([
    ["a matter id of 0", { matter_id: 0, paths: [FOLDER] }],
    ["a fractional matter id", { matter_id: 7.5, paths: [FOLDER] }],
    ["no path", { matter_id: 7, paths: [] }],
    ["51 paths", { matter_id: 7, paths: Array.from({ length: 51 }, () => FOLDER) }],
    ["an empty path", { matter_id: 7, paths: [""] }],
    ["a path over 1024 characters", { matter_id: 7, paths: [`/${"α".repeat(1024)}`] }],
    ["the role the server keeps for itself", { matter_id: 7, paths: [FOLDER], role: "generated" }],
    ["an unknown side", { matter_id: 7, paths: [FOLDER], side: "both" }],
  ])("refuses for upload_to_matter %s", (_, args) => {
    expect(schemaOf("upload_to_matter").safeParse(args).success).toBe(false);
  });

  it("takes for create_matter a title, trimmed, and the optional fields", () => {
    const parsed = schemaOf("create_matter").safeParse({
      title: "  Κυριάκου v Δήμου Λευκωσίας  ",
      type: "interim_application",
      case_reference: "Αίτηση 45/2026",
      description: "Αίτηση για προσωρινό διάταγμα",
    });
    expect(parsed.data).toEqual({
      title: "Κυριάκου v Δήμου Λευκωσίας",
      type: "interim_application",
      case_reference: "Αίτηση 45/2026",
      description: "Αίτηση για προσωρινό διάταγμα",
    });
  });

  it.each([
    ["a blank title", { title: "   " }],
    ["a title over 300 characters", { title: "Α".repeat(301) }],
    ["an unknown type", { title: "Κυριάκου v Δήμου Λευκωσίας", type: "family" }],
    ["a case reference over 300 characters", { title: "Κυριάκου v Δήμου Λευκωσίας", case_reference: "1".repeat(301) }],
    ["a description over 2000 characters", { title: "Κυριάκου v Δήμου Λευκωσίας", description: "Α".repeat(2001) }],
  ])("refuses for create_matter %s", (_, args) => {
    expect(schemaOf("create_matter").safeParse(args).success).toBe(false);
  });
});
