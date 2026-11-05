// The init tools against recording fakes over a real project folder: each test builds the folder
// "Παπαδόπουλος v Γεωργίου" in a fresh temporary directory, with real small PDF, DOCX and text files,
// and runs the real scanner, link file and selection store over it. The session, the API, the
// native runtime and the upload are fakes; `calls` lists the API and upload steps in the order they
// were taken, and the upload records what the link file held when it started. Every result goes
// through run(), which fails the test when the access token appears anywhere in it. The
// registration tests connect a real McpServer to a real Client in memory.

import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { RESOURCE_MIME_TYPE, RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps/server";
import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeDocx } from "../../test/support/docx-fixture";
import { textPdf } from "../../test/support/pdf-fixtures";
import type { CurrentUser, DikigorosApi, Matter, MatterDetail, MatterDocumentSummary, MatterSummary } from "../api/client";
import { ApiError } from "../api/errors";
import type { SignInPrompt } from "../auth/session";
import type { HelperConfig } from "../config";
import type { PlanEntry } from "../files/resolve";
import { scanProject } from "../files/scan";
import { LINK_DIR, LINK_FILE, type LinkRead, type MatterLink, readLink, writeLink } from "../link/link-file";
import type { DocumentOutcome, UploadContext } from "../pipeline/upload-document";
import { PICKER_MATTER_TYPES, type PickerInput } from "../shared/picker-contract";
import {
  handleInitMatter,
  handleLoadPicker,
  handleSaveSelection,
  handleScanProject,
  handleShowProjectPicker,
  type InitToolDeps,
  PICKER_URI,
  pickerReason,
  registerInitTools,
} from "./init-tools";
import { SelectionStore } from "./selections";
import { CALL_BUDGET_MS, type CallContext, formatSize, MATTER_TYPES } from "./tools";

const TOKEN = "tok_secret";
const BASE_URL = "https://dikigoros.ai";

const CONFIG: HelperConfig = {
  baseUrl: BASE_URL,
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

const ME: CurrentUser = {
  id: 42,
  email: "eleni@example.com",
  plan: "firm",
  entitlements: { mattersAccess: true, docsPerMatter: 50, activeMatters: 10, tier: "firm" },
};

/** The matter a linked folder names. */
const LINKED: Matter = {
  id: 12,
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

/** POST /api/matters: the matter init_matter opens. */
const CREATED: Matter = {
  ...LINKED,
  id: 9,
  title: "Παπαδόπουλος v Γεωργίου",
  caseReference: "Αγωγή 77/2026",
  createdAt: "2026-11-05T10:00:00.000Z",
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

/** GET /api/matters/{id}: the matter with `held` documents. */
function detail(id: number, held: number): MatterDetail {
  const matter = id === CREATED.id ? CREATED : { ...LINKED, id };
  const documents = Array.from({ length: held }, (_, i) => ({ ...DOCUMENT, id: 100 + i }));
  return { matter, documents, pins: [], notes: [], artifacts: [] };
}

/** `count` rows of GET /api/matters, all active. */
function openMatters(count: number): MatterSummary[] {
  return Array.from({ length: count }, (_, i) => ({
    id: 200 + i,
    title: `Matter ${i}`,
    caseReference: "",
    matterType: null,
    status: "active",
    updatedAt: "2026-10-18T09:00:00.000Z",
    documentCount: 0,
  }));
}

const NOW = 1_762_336_800_000; // 2026-11-05T10:00:00Z
const SHA = "ab".repeat(32);

let base: string;
/** The project folder, as the model names it. */
let root: string;
let homeDir: string;
let PDF: Uint8Array;
let OLD_PDF: Uint8Array;
let DOCX: Uint8Array;
const NOTES = "# Σημειώσεις\n\nΗ πρώτη δικάσιμος.\n";

beforeAll(async () => {
  PDF = textPdf(["Statement of claim"]);
  OLD_PDF = textPdf(["Statement of claim, an earlier draft"]);
  DOCX = await makeDocx(["Υπεράσπιση"]);
});

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "dikigoros-init-")));
  root = join(base, "Παπαδόπουλος v Γεωργίου");
  homeDir = join(base, "home");
  await mkdir(homeDir);
  await put("Pleadings/Αγωγή.pdf", PDF);
  await put("Pleadings/Υπεράσπιση.docx", DOCX);
  await put("Old/Αγωγή.pdf", OLD_PDF);
  await put("notes.md", NOTES);
  await put("photo.jpg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
  await put("empty.txt", "");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(base, { recursive: true, force: true });
});

/** Writes `content` at `rel` under the project, creating parent folders. */
async function put(rel: string, content: string | Uint8Array): Promise<string> {
  const path = join(root, ...rel.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
}

const abs = (rel: string) => join(root, ...rel.split("/"));

/** A link file naming matter 12, recording Pleadings/Αγωγή.pdf as uploaded with its size and mtime now. */
async function linkFolder(over: Partial<MatterLink> = {}): Promise<MatterLink> {
  const sent = await stat(abs("Pleadings/Αγωγή.pdf"));
  const link: MatterLink = {
    version: 1,
    baseUrl: BASE_URL,
    matterId: 12,
    title: LINKED.title,
    url: `${BASE_URL}/matters/12`,
    createdAt: "2026-10-01T09:00:00.000Z",
    files: [
      {
        relativePath: "Pleadings/Αγωγή.pdf",
        storedName: "Αγωγή.pdf",
        sizeBytes: sent.size,
        mtimeMs: sent.mtimeMs,
        sha256: SHA,
        docId: 100,
        status: "ready",
      },
    ],
    ...over,
  };
  await writeLink(root, link);
  return link;
}

interface Setup {
  token?: string | null;
  me?: CurrentUser;
  matters?: MatterSummary[];
  /** How many documents GET /api/matters/{id} lists; an Error to reject. */
  held?: number | Error;
  created?: Matter | Error;
  ui?: boolean;
  runtime?: Error;
  /** The upload's outcome for an entry; the default is ready, with a document id and a hash for a PDF or DOCX. */
  upload?: (entry: PlanEntry, ctx: UploadContext) => Promise<DocumentOutcome>;
  /** Replaces the link file's write; it is passed the real one. */
  writeLink?: (real: typeof writeLink, at: string, link: MatterLink) => Promise<void>;
  config?: Partial<HelperConfig>;
}

function fakes(setup: Setup = {}) {
  const calls: string[] = [];
  const step = <T>(label: string, value: T | Error): T => {
    calls.push(label);
    if (value instanceof Error) throw value;
    return value;
  };
  const session = {
    getAccessToken: vi.fn(async () => step("getAccessToken", setup.token === undefined ? TOKEN : setup.token)),
    beginSignIn: vi.fn(async () => step("beginSignIn", PROMPT)),
    forgetSession: vi.fn(async () => step("forgetSession", undefined)),
  };
  const api = {
    currentUser: vi.fn<DikigorosApi["currentUser"]>(async () => step("currentUser", setup.me ?? ME)),
    listMatters: vi.fn<DikigorosApi["listMatters"]>(async () => step("listMatters", setup.matters ?? openMatters(3))),
    getMatter: vi.fn<DikigorosApi["getMatter"]>(async (id) => {
      const held = setup.held ?? 0;
      return step(`getMatter(${id})`, held instanceof Error ? held : detail(id, held));
    }),
    createMatter: vi.fn<DikigorosApi["createMatter"]>(async () => step("createMatter", setup.created ?? CREATED)),
  };
  /** What the link file held as each upload started. */
  const linkAtUpload: LinkRead[] = [];
  let documentId = 300;
  const upload = vi.fn<InitToolDeps["upload"]>(async (entry, ctx) => {
    calls.push(`upload(${entry.name})`);
    linkAtUpload.push(await readLink(root));
    if (setup.upload !== undefined) return setup.upload(entry, ctx);
    const outcome: DocumentOutcome = { name: entry.name, status: "ready", documentId: ++documentId, pageCount: 1 };
    if (entry.kind !== "text") outcome.sha256 = SHA;
    return outcome;
  });
  const nativeRuntime = vi.fn<InitToolDeps["nativeRuntime"]>(async () =>
    step("nativeRuntime", setup.runtime ?? { nodeModulesDir: "/native/node_modules" }),
  );
  const clock = { now: NOW };
  const writes = vi.fn(async (at: string, link: MatterLink) =>
    setup.writeLink === undefined ? writeLink(at, link) : setup.writeLink(writeLink, at, link),
  );
  const deps: InitToolDeps = {
    config: { ...CONFIG, ...setup.config },
    session,
    api: api as unknown as DikigorosApi,
    resolvePlan: vi.fn(async () => {
      throw new Error("the init tools never resolve a 0.1.0 plan");
    }),
    upload,
    nativeRuntime,
    tokenStoreWarning: async () => null,
    now: () => clock.now,
    scanProject: vi.fn(scanProject),
    links: { read: vi.fn(readLink), write: writes },
    selections: new SelectionStore({ now: () => clock.now }),
    homeDir,
    pickerHtml: async () => "<!doctype html><html><body><script>/* picker */</script></body></html>",
    uiSupported: () => setup.ui ?? true,
  };
  return { deps, calls, session, api, upload, nativeRuntime, clock, linkAtUpload, writes };
}

type Fakes = ReturnType<typeof fakes>;

/** The handler's result, checked on its way out for the session's access token. */
async function run<A>(
  handler: (args: A, deps: InitToolDeps, ctx?: CallContext) => Promise<CallToolResult>,
  args: A,
  deps: InitToolDeps,
  ctx?: CallContext,
): Promise<CallToolResult> {
  const result = await handler(args, deps, ctx);
  expect(JSON.stringify(result)).not.toContain(TOKEN);
  return result;
}

function textOf(result: CallToolResult): string {
  expect(result.content).toHaveLength(1);
  const [block] = result.content;
  if (block.type !== "text") throw new Error(`expected a text block, got ${block.type}`);
  return block.text;
}

/** The structured content of a result, as a plain record. */
function factsOf(result: CallToolResult): Record<string, unknown> {
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

/** scan_project over the folder, answering its scan_id. */
async function scanned(f: Fakes): Promise<string> {
  const result = await run(handleScanProject, { root }, f.deps);
  expect(result.isError).toBeUndefined();
  return factsOf(result).scan_id as string;
}

/** A scan and a saved selection of `paths`, with `matter` for a new matter. */
async function confirmed(
  f: Fakes,
  paths: string[],
  matter: { title: string; type?: (typeof MATTER_TYPES)[number] } | undefined = { title: CREATED.title },
): Promise<{ scan_id: string; selection_id: string; digest: string }> {
  const scan_id = await scanned(f);
  const saved = await run(handleSaveSelection, { scan_id, relative_paths: paths, matter }, f.deps);
  expect(saved.isError).toBeUndefined();
  const { selection_id, digest } = factsOf(saved) as { selection_id: string; digest: string };
  return { scan_id, selection_id, digest };
}

/** The request context of a call: aborted when `aborted`, with a progress token when one is given. */
function requestContext({ aborted = false, progressToken }: { aborted?: boolean; progressToken?: string } = {}) {
  const controller = new AbortController();
  if (aborted) controller.abort();
  const notify = vi.fn<CallContext["mcpReq"]["notify"]>(async () => {});
  const ctx: CallContext = {
    mcpReq: { signal: controller.signal, _meta: progressToken === undefined ? undefined : { progressToken }, notify },
  };
  return { ctx, notify, controller };
}

async function linkOnDisk(): Promise<LinkRead> {
  return readLink(root);
}

const PICKED = ["Pleadings/Αγωγή.pdf", "Pleadings/Υπεράσπιση.docx", "notes.md"];

// ---------- scan_project ----------

describe("scan_project", () => {
  it("starts a sign-in when nobody is signed in, and scans nothing", async () => {
    const f = fakes({ token: null });
    const result = await run(handleScanProject, { root }, f.deps);
    expect(factsOf(result).status).toBe("sign_in_required");
    expect(f.calls).toEqual(["getAccessToken", "beginSignIn"]);
    expect(f.deps.scanProject).not.toHaveBeenCalled();
  });

  it("answers the Firm-plan sentence without mattersAccess", async () => {
    const f = fakes({ me: { ...ME, entitlements: { ...ME.entitlements, mattersAccess: false } } });
    const result = await run(handleScanProject, { root }, f.deps);
    expect(result).toStrictEqual({
      content: [{ type: "text", text: "This needs the Firm plan (Matters). Plans: https://dikigoros.ai/pricing" }],
      isError: true,
    });
    expect(f.deps.scanProject).not.toHaveBeenCalled();
  });

  it("forgets a session the current-user route refuses, and starts a new sign-in", async () => {
    const f = fakes();
    f.api.currentUser.mockRejectedValueOnce(new ApiError(401, "Authentication required"));
    const result = await run(handleScanProject, { root }, f.deps);
    expect(factsOf(result).status).toBe("sign_in_required");
    expect(f.session.forgetSession).toHaveBeenCalledTimes(1);
  });

  it("answers the active-matter limit, and nothing else, when 10 of 10 are open and the folder is not linked", async () => {
    const f = fakes({ matters: [...openMatters(10), { ...openMatters(1)[0], id: 900, status: "archived" }] });
    const result = await run(handleScanProject, { root }, f.deps);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(textOf(result)).toContain("10 of 10 active matters");
    expect(textOf(result)).not.toContain("Pleadings");
  });

  it("scans a linked folder even with 10 of 10 matters open: no new matter is needed", async () => {
    await linkFolder();
    const f = fakes({ matters: openMatters(10) });
    const result = await run(handleScanProject, { root }, f.deps);
    expect(result.isError).toBeUndefined();
    expect(factsOf(result).mode).toBe("linked");
  });

  it("returns a compact summary: room, per-folder counts, at most 300 eligible paths, and a scan_id", async () => {
    for (let i = 0; i < 305; i++) await put(`Bulk/n-${String(i).padStart(3, "0")}.txt`, `σημείωση ${i}\n`);
    const f = fakes();
    const result = await run(handleScanProject, { root }, f.deps);
    const facts = factsOf(result);

    expect(facts.status).toBe("scanned");
    expect(facts.scan_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(facts.root).toBe(root);
    expect(facts.mode).toBe("new");
    expect(facts.room).toStrictEqual({ room: 50, per_matter: 50, held: 0, active_matters: { limit: 10, open: 3 } });
    expect(facts.counts).toStrictEqual({ files: 311, eligible: 309, ineligible: { empty: 1, unsupported_type: 1 } });
    expect(facts.folders).toStrictEqual([
      { path: "", files: 3, eligible: 1, ineligible: { empty: 1, unsupported_type: 1 } },
      { path: "Bulk", files: 305, eligible: 305, ineligible: {} },
      { path: "Old", files: 1, eligible: 1, ineligible: {} },
      { path: "Pleadings", files: 2, eligible: 2, ineligible: {} },
    ]);
    const eligible = facts.eligible_files as Array<{ path: string; size_bytes: number; type: string }>;
    expect(eligible).toHaveLength(300);
    expect(eligible[0]).toStrictEqual({ path: "notes.md", size_bytes: Buffer.byteLength(NOTES), type: "text" });
    expect(facts.eligible_files_omitted).toBe(9);
    expect(facts.truncated).toBeNull();

    const text = textOf(result);
    expect(text.split("\n")[0]).toBe(`Scanned ${root}: a new matter would be opened.`);
    expect(text).toContain("Room for this call: 50 documents (50 per matter, 0 held).");
    expect(text).toContain("309 of 311 files eligible; not eligible: empty 1, unsupported_type 1.");
    expect(text).toContain("Bulk: 305 eligible");
    expect(text).toContain("(top level): 1 eligible, empty 1, unsupported_type 1");
    expect(text).toContain("… and 9 more eligible files, counted in the folders above.");
    expect(text).toContain(`scan_id: ${facts.scan_id as string}`);
    expect(text.split("\n").filter((line) => line.includes(" · "))).toHaveLength(300);
    expect(text).not.toContain("photo.jpg");

    // The scan is held: the picker can load it.
    const loaded = await run(handleLoadPicker, { scan_id: facts.scan_id as string }, f.deps);
    expect(loaded.isError).toBeUndefined();
  });

  it("in a linked folder: names the matter, marks uploaded files, room = limit − held", async () => {
    await linkFolder();
    const f = fakes({ held: 44 });
    const result = await run(handleScanProject, { root }, f.deps);
    const facts = factsOf(result);

    expect(facts.mode).toBe("linked");
    expect(facts.linked_matter).toStrictEqual({ id: 12, title: LINKED.title, url: `${BASE_URL}/matters/12` });
    expect(facts.room).toStrictEqual({ room: 6, per_matter: 50, held: 44, active_matters: { limit: 10, open: 3 } });
    expect(facts.counts).toStrictEqual({
      files: 6,
      eligible: 3,
      ineligible: { already_uploaded: 1, empty: 1, unsupported_type: 1 },
    });
    const text = textOf(result);
    expect(text.split("\n")[0]).toBe(`Scanned ${root}: linked to matter #12 "${LINKED.title}" (${BASE_URL}/matters/12).`);
    expect(text).toContain("Room for this call: 6 documents (50 per matter, 44 held).");
    expect(text).toContain("Pleadings: 1 eligible, already_uploaded 1");
  });

  it("gives a plan without a per-matter limit a room of 100", async () => {
    const f = fakes({ me: { ...ME, entitlements: { ...ME.entitlements, docsPerMatter: -1, activeMatters: -1 } } });
    const result = await run(handleScanProject, { root }, f.deps);
    expect(factsOf(result).room).toStrictEqual({
      room: 100,
      per_matter: null,
      held: 0,
      active_matters: { limit: null, open: 3 },
    });
    expect(textOf(result)).toContain("Room for this call: 100 documents (no per-matter limit).");
  });

  it("reports a link file for another base URL, and offers a new matter without asking that matter", async () => {
    await linkFolder({ baseUrl: "https://staging.dikigoros.ai" });
    const f = fakes();
    const result = await run(handleScanProject, { root }, f.deps);
    expect(factsOf(result).mode).toBe("new");
    expect(factsOf(result).notice).toBe(
      "The folder's link file names matter #12 on https://staging.dikigoros.ai, not on https://dikigoros.ai; " +
        "a new matter would be opened here.",
    );
    expect(f.calls).not.toContain("getMatter(12)");
  });

  it("reports a linked matter that answers 404, and offers a new matter", async () => {
    await linkFolder();
    const f = fakes({ held: new ApiError(404, "Matter not found") });
    const result = await run(handleScanProject, { root }, f.deps);
    const facts = factsOf(result);
    expect(facts.mode).toBe("new");
    expect(facts.notice).toBe("The folder's linked matter #12 is gone (or not yours); a new matter would be opened.");
    // Nothing is marked uploaded against a matter that is not there.
    expect((facts.counts as { eligible: number }).eligible).toBe(4);
    expect(textOf(result)).toContain(facts.notice as string);
  });

  it("reports a link file that cannot be read, offers a new matter, and leaves the file as it was", async () => {
    const path = await put(`${LINK_DIR}/${LINK_FILE}`, "{not json");
    const f = fakes();
    const result = await run(handleScanProject, { root }, f.deps);
    expect(factsOf(result).mode).toBe("new");
    expect(factsOf(result).notice).toBe(
      "The folder's link file cannot be used (the link file is not valid JSON); a new matter would be opened, " +
        "and the file is replaced only when init_matter runs.",
    );
    expect(await readFile(path, "utf8")).toBe("{not json");
    expect(f.writes).not.toHaveBeenCalled();
  });

  it("answers an API failure other than 404 of the linked matter with its sentence", async () => {
    await linkFolder();
    const f = fakes({ held: new Error("connect ECONNREFUSED 127.0.0.1:443") });
    const result = await run(handleScanProject, { root }, f.deps);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Could not reach DIKIGOROS (connect ECONNREFUSED 127.0.0.1:443). Nothing was changed; try again in a moment.");
  });

  it("makes only GET /auth/current-user and GET /api/matters, and GET /api/matters/{id} when linked", async () => {
    const f = fakes();
    await run(handleScanProject, { root }, f.deps);
    expect(f.calls).toEqual(["getAccessToken", "currentUser", "listMatters"]);

    await linkFolder();
    const g = fakes();
    await run(handleScanProject, { root }, g.deps);
    expect(g.calls).toEqual(["getAccessToken", "currentUser", "listMatters", "getMatter(12)"]);
    for (const { api, upload, writes } of [f, g]) {
      expect(api.createMatter).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["a relative path", () => "Matters/Παπαδόπουλος", "The folder must be given as an absolute path. Nothing was scanned."],
    [
      "the home directory",
      () => homeDir,
      "The home directory, or a folder holding it, is not one project; name the project's own folder. Nothing was scanned.",
    ],
    ["a folder that is not there", () => join(base, "nowhere"), "The folder does not exist. Nothing was scanned."],
    ["a file", () => abs("notes.md"), "That path is a file, not a folder. Nothing was scanned."],
  ])("refuses %s as the root", async (_what, rootOf, sentence) => {
    const f = fakes();
    const result = await run(handleScanProject, { root: rootOf() }, f.deps);
    expect(result).toStrictEqual({ content: [{ type: "text", text: sentence }], isError: true });
  });
});

// ---------- show_project_picker ----------

describe("show_project_picker", () => {
  it("answers picker_unavailable when the client has no MCP Apps support", async () => {
    const f = fakes({ ui: false });
    const scan_id = await scanned(f);
    const result = await run(handleShowProjectPicker, { scan_id, matter: { title: CREATED.title } }, f.deps);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toStrictEqual({ status: "picker_unavailable", scan_id });
    expect(textOf(result)).toBe(
      "This client cannot show the picker; continue with the text fallback of the init-matter skill " +
        "(init_matter with root and relative_paths).",
    );
  });

  it("opens the picker: a small result, never the tree or a path, and a sentence to wait", async () => {
    const f = fakes();
    const scan_id = await scanned(f);
    const result = await run(
      handleShowProjectPicker,
      { scan_id, matter: { title: CREATED.title, type: "civil" }, preselect: PICKED },
      f.deps,
    );
    expect(result.structuredContent).toStrictEqual({
      status: "picker_open",
      scan_id,
      mode: "new",
      room: 50,
      eligible: 4,
      preselected: 3,
    });
    expect(textOf(result)).toBe(
      "The picker is open; the lawyer confirms there. Wait for the confirmation message, then call init_matter " +
        "with the selection_id and digest it gives. Do not call init_matter before it.",
    );
    const json = JSON.stringify(result);
    for (const leak of [root, "Pleadings", "notes.md", "Αγωγή", "photo.jpg"]) expect(json).not.toContain(leak);
  });

  it("drops preselected paths that are not in the scan, ineligible, given twice or over the room", async () => {
    const f = fakes({ me: { ...ME, entitlements: { ...ME.entitlements, docsPerMatter: 2 } } });
    const scan_id = await scanned(f);
    const preselect = ["photo.jpg", "Nowhere.pdf", "notes.md", "notes.md", "Pleadings/Αγωγή.pdf", "Old/Αγωγή.pdf"];
    const result = await run(handleShowProjectPicker, { scan_id, matter: { title: CREATED.title }, preselect }, f.deps);
    expect(factsOf(result).preselected).toBe(2);
    const loaded = factsOf(await run(handleLoadPicker, { scan_id }, f.deps)) as unknown as PickerInput;
    expect(loaded.preselect).toEqual(["notes.md", "Pleadings/Αγωγή.pdf"]);
  });

  it("ignores the proposed matter in a linked folder", async () => {
    await linkFolder();
    const f = fakes();
    const scan_id = await scanned(f);
    await run(handleShowProjectPicker, { scan_id, matter: { title: "Άλλη υπόθεση" } }, f.deps);
    const loaded = factsOf(await run(handleLoadPicker, { scan_id }, f.deps));
    expect(loaded.mode).toBe("linked");
    expect(loaded).not.toHaveProperty("matter");
  });

  it("answers unknown_scan for a scan_id it does not hold", async () => {
    const f = fakes();
    const result = await run(handleShowProjectPicker, { scan_id: "AAAAAAAAAAAAAAAAAAAAAA" }, f.deps);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toStrictEqual({ status: "unknown_scan", scan_id: "AAAAAAAAAAAAAAAAAAAAAA" });
    expect(textOf(result)).toBe(
      "This helper holds no scan with that scan_id (it restarted, or newer scans replaced it). Call scan_project again.",
    );
  });

  it("starts a sign-in when nobody is signed in", async () => {
    const f = fakes();
    const scan_id = await scanned(f);
    f.session.getAccessToken.mockResolvedValueOnce(null);
    const result = await run(handleShowProjectPicker, { scan_id }, f.deps);
    expect(factsOf(result).status).toBe("sign_in_required");
  });
});

// ---------- load_picker ----------

describe("load_picker", () => {
  it("returns the stored PickerInput: the whole tree, the limits and the proposal", async () => {
    const f = fakes();
    const scan_id = await scanned(f);
    await run(
      handleShowProjectPicker,
      { scan_id, matter: { title: CREATED.title, type: "civil", case_reference: "Αγωγή 77/2026" }, preselect: PICKED },
      f.deps,
    );
    const result = await run(handleLoadPicker, { scan_id }, f.deps);
    const pdf = (path: string, bytes: Uint8Array) => ({
      path,
      name: "Αγωγή.pdf",
      size_bytes: bytes.length,
      type: "pdf",
      eligible: true,
    });
    const expected: PickerInput = {
      scan_id,
      mode: "new",
      root,
      room: 50,
      per_matter: 50,
      held: 0,
      matter: { title: CREATED.title, type: "civil", case_reference: "Αγωγή 77/2026" },
      preselect: PICKED,
      folders: [
        { path: "", depth: 0 },
        { path: "Old", depth: 1 },
        { path: "Pleadings", depth: 1 },
      ],
      files: [
        { path: "empty.txt", name: "empty.txt", size_bytes: 0, type: "text", eligible: false, reason: "empty" },
        { path: "notes.md", name: "notes.md", size_bytes: Buffer.byteLength(NOTES), type: "text", eligible: true },
        { path: "photo.jpg", name: "photo.jpg", size_bytes: 8, type: null, eligible: false, reason: "unsupported_type" },
        pdf("Old/Αγωγή.pdf", OLD_PDF) as PickerInput["files"][number],
        pdf("Pleadings/Αγωγή.pdf", PDF) as PickerInput["files"][number],
        {
          path: "Pleadings/Υπεράσπιση.docx",
          name: "Υπεράσπιση.docx",
          size_bytes: DOCX.length,
          type: "docx",
          eligible: true,
        },
      ],
      truncated: null,
    };
    expect(result.structuredContent).toStrictEqual(expected);
    expect(result.isError).toBeUndefined();
  });

  it("returns a linked folder's matter and limits, its uploaded files marked", async () => {
    await linkFolder();
    const f = fakes({ held: 44 });
    const scan_id = await scanned(f);
    const loaded = factsOf(await run(handleLoadPicker, { scan_id }, f.deps)) as unknown as PickerInput;
    expect(loaded.linked_matter).toStrictEqual({ id: 12, title: LINKED.title, url: `${BASE_URL}/matters/12` });
    expect([loaded.room, loaded.per_matter, loaded.held]).toEqual([6, 50, 44]);
    expect(loaded.preselect).toEqual([]);
    expect(loaded.files.find((file) => file.path === "Pleadings/Αγωγή.pdf")?.reason).toBe("already_uploaded");
  });

  it("needs no sign-in and makes no request: it reads the helper's memory only", async () => {
    const f = fakes();
    const scan_id = await scanned(f);
    f.calls.length = 0;
    f.session.getAccessToken.mockResolvedValue(null);
    const result = await run(handleLoadPicker, { scan_id }, f.deps);
    expect(result.isError).toBeUndefined();
    expect(f.calls).toEqual([]);
  });

  it("answers unknown_scan for a scan_id it does not hold", async () => {
    const f = fakes();
    const result = await run(handleLoadPicker, { scan_id: "nope" }, f.deps);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toStrictEqual({ status: "unknown_scan", scan_id: "nope" });
  });

  it.each([
    ["unsupported_type", "unsupported_type"],
    ["too_large", "too_large"],
    ["empty", "empty"],
    ["unreadable", "unreadable"],
    ["outside_directory", "outside_directory"],
    ["not_found", "not_found"],
    ["already_uploaded", "already_uploaded"],
    ["dotfile", "other"],
    ["not_a_file", "other"],
    ["too_many_files", "other"],
    ["duplicate_path", "other"],
    ["not_absolute", "other"],
  ] as const)("shows the scan's reason %s as %s", (scanReason, shown) => {
    expect(pickerReason(scanReason)).toBe(shown);
  });
});

// ---------- save_selection ----------

describe("save_selection", () => {
  it("returns selection_id and digest for a valid selection", async () => {
    const f = fakes();
    const scan_id = await scanned(f);
    f.calls.length = 0;
    const result = await run(
      handleSaveSelection,
      { scan_id, relative_paths: PICKED, matter: { title: `  ${CREATED.title}  ` } },
      f.deps,
    );
    const facts = factsOf(result);
    expect(facts).toStrictEqual({
      selection_id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      digest: expect.stringMatching(/^[0-9a-f]{16}$/),
      count: 3,
      total_bytes: PDF.length + DOCX.length + Buffer.byteLength(NOTES),
    });
    expect(f.calls).toEqual([]);
    expect(f.deps.selections.getSelection(facts.selection_id as string)?.matter).toStrictEqual({ title: CREATED.title });
  });

  it.each([
    ["unknown_scan", { scan_id: "nope", relative_paths: ["notes.md"] }, { refused: "unknown_scan" }],
    ["not_in_scan", { relative_paths: ["Nowhere.pdf"] }, { refused: "not_in_scan", path: "Nowhere.pdf" }],
    ["ineligible", { relative_paths: ["photo.jpg"] }, { refused: "ineligible", path: "photo.jpg" }],
    ["duplicate_path", { relative_paths: ["notes.md", "notes.md"] }, { refused: "duplicate_path", path: "notes.md" }],
    ["empty_selection", { relative_paths: [] }, { refused: "empty_selection" }],
    ["title_required", { relative_paths: ["notes.md"], matter: { title: "   " } }, { refused: "title_required" }],
    ["title_required (no matter)", { relative_paths: ["notes.md"], matter: undefined }, { refused: "title_required" }],
  ])("refuses %s with its sentence", async (_code, over, refusal) => {
    const f = fakes();
    const scan_id = await scanned(f);
    const args = { scan_id, matter: { title: CREATED.title }, ...over };
    const result = await run(handleSaveSelection, args, f.deps);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toStrictEqual(refusal);
    expect(textOf(result)).toBe(SENTENCES[refusal.refused]);
  });

  it("refuses an over-room list", async () => {
    const f = fakes({ me: { ...ME, entitlements: { ...ME.entitlements, docsPerMatter: 2 } } });
    const scan_id = await scanned(f);
    const result = await run(handleSaveSelection, { scan_id, relative_paths: PICKED, matter: { title: "Τ" } }, f.deps);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toStrictEqual({ refused: "over_room" });
    expect(textOf(result)).toBe("3 files are more than the 2 this matter has room for in one call.");
  });

  it("refuses a file a linked folder's matter already holds", async () => {
    await linkFolder();
    const f = fakes();
    const scan_id = await scanned(f);
    const result = await run(handleSaveSelection, { scan_id, relative_paths: ["Pleadings/Αγωγή.pdf"] }, f.deps);
    expect(result.structuredContent).toStrictEqual({ refused: "ineligible", path: "Pleadings/Αγωγή.pdf" });
    expect(textOf(result)).toBe("Pleadings/Αγωγή.pdf is already in the matter.");
  });

  it("needs no sign-in", async () => {
    const f = fakes();
    const scan_id = await scanned(f);
    f.session.getAccessToken.mockResolvedValue(null);
    const result = await run(handleSaveSelection, { scan_id, relative_paths: ["notes.md"], matter: { title: "Τ" } }, f.deps);
    expect(result.isError).toBeUndefined();
  });
});

const SENTENCES: Record<string, string> = {
  unknown_scan: "This helper holds no scan with that scan_id (it restarted, or newer scans replaced it). Call scan_project again.",
  not_in_scan: "Nowhere.pdf is not in the scan.",
  ineligible: "photo.jpg cannot be uploaded (unsupported_type).",
  duplicate_path: "notes.md is named twice.",
  empty_selection: "No file is selected.",
  title_required: "The new matter needs a title of 1 to 300 characters.",
};

// ---------- init_matter, from the picker ----------

describe("init_matter from the picker", () => {
  it("refuses a selection_id it never issued, and does nothing", async () => {
    const f = fakes();
    await confirmed(f, PICKED);
    f.calls.length = 0;
    const result = await run(handleInitMatter, { selection_id: "AAAAAAAAAAAAAAAAAAAAAA", digest: "0123456789abcdef" }, f.deps);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toStrictEqual({ status: "unknown_selection" });
    expect(textOf(result)).toBe(
      "This helper issued no selection with that selection_id (it restarted, or newer scans replaced it). " +
        "Nothing was done; open the picker again.",
    );
    expect(f.calls).toEqual(["getAccessToken"]);
    expect(await linkOnDisk()).toStrictEqual({ kind: "none" });
  });

  it("refuses a digest that does not match the selection, and does nothing", async () => {
    const f = fakes();
    const { selection_id } = await confirmed(f, PICKED);
    f.calls.length = 0;
    const result = await run(handleInitMatter, { selection_id, digest: "0123456789abcdef" }, f.deps);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toStrictEqual({ status: "digest_mismatch" });
    expect(textOf(result)).toBe("The digest does not match that selection. Nothing was done; open the picker again.");
    expect(f.calls).toEqual(["getAccessToken"]);
    expect(await linkOnDisk()).toStrictEqual({ kind: "none" });
  });

  it("creates the matter, writes the link file BEFORE the first upload, then uploads and records each outcome", async () => {
    const f = fakes();
    const { selection_id, digest } = await confirmed(f, PICKED, { title: CREATED.title, type: "civil" });
    f.calls.length = 0;
    const result = await run(handleInitMatter, { selection_id, digest }, f.deps);

    expect(f.calls).toEqual([
      "getAccessToken",
      "currentUser",
      "createMatter",
      "nativeRuntime",
      "upload(Αγωγή.pdf)",
      "upload(Υπεράσπιση.docx)",
      "upload(notes.md)",
    ]);
    expect(f.api.createMatter).toHaveBeenCalledWith({
      title: CREATED.title,
      matterType: "civil",
      caseReference: undefined,
      description: undefined,
    });
    const first = {
      version: 1,
      baseUrl: BASE_URL,
      matterId: 9,
      title: CREATED.title,
      url: `${BASE_URL}/matters/9`,
      createdAt: new Date(NOW).toISOString(),
      files: [],
    };
    expect(f.linkAtUpload[0]).toStrictEqual({ kind: "ok", link: first });
    expect(f.linkAtUpload.map((read) => (read.kind === "ok" ? read.link.files.length : -1))).toEqual([0, 1, 2]);

    const pdfStat = await stat(abs("Pleadings/Αγωγή.pdf"));
    const disk = await linkOnDisk();
    if (disk.kind !== "ok") throw new Error("expected a link file");
    expect(disk.link.files).toStrictEqual([
      {
        relativePath: "Pleadings/Αγωγή.pdf",
        storedName: "Αγωγή.pdf",
        sizeBytes: PDF.length,
        mtimeMs: pdfStat.mtimeMs,
        sha256: SHA,
        docId: 301,
        status: "ready",
      },
      expect.objectContaining({ relativePath: "Pleadings/Υπεράσπιση.docx", sha256: SHA, docId: 302, status: "ready" }),
      expect.objectContaining({ relativePath: "notes.md", storedName: "notes.md", sha256: null, docId: 303 }),
    ]);

    const [upload] = f.upload.mock.calls[0];
    expect(upload).toStrictEqual({
      path: abs("Pleadings/Αγωγή.pdf"),
      realPath: abs("Pleadings/Αγωγή.pdf"),
      name: "Αγωγή.pdf",
      sizeBytes: PDF.length,
      kind: "pdf",
      decision: "upload",
    });
    expect(f.upload.mock.calls[0][1]).toStrictEqual({ baseUrl: BASE_URL, userId: 42, matterId: 9 });

    const facts = factsOf(result);
    expect(facts).toMatchObject({
      status: "done",
      matter_created: true,
      matter_id: 9,
      matter_url: `${BASE_URL}/matters/9`,
      left_over: 1,
      left_over_paths: ["Old/Αγωγή.pdf"],
      gitignore_hint: false,
    });
    expect((facts.results as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: "Αγωγή.pdf",
      relative_path: "Pleadings/Αγωγή.pdf",
      status: "ready",
      doc_id: 301,
    });
    expect(textOf(result)).toBe(
      [
        `Created matter #9 "${CREATED.title}" and linked this folder to it.`,
        "Αγωγή.pdf: ready",
        "Υπεράσπιση.docx: ready",
        "notes.md: ready",
        `Matter #9: ${BASE_URL}/matters/9`,
        "1 eligible file was not selected: Old/Αγωγή.pdf",
      ].join("\n"),
    );
  });

  it("a failure after the create leaves the folder linked to the new matter, and the next run reuses it", async () => {
    let failOnce = true;
    const f = fakes({
      upload: async (entry) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("socket hang up");
        }
        return { name: entry.name, status: "ready", documentId: 400 };
      },
    });
    const { selection_id, digest } = await confirmed(f, PICKED);
    const failed = await run(handleInitMatter, { selection_id, digest }, f.deps);

    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toBe(
      "Could not reach DIKIGOROS (socket hang up). Matter #9 (https://dikigoros.ai/matters/9) is linked to this " +
        "folder; 0 of 3 files were finished before this. Call init_matter again to resume: files already in the " +
        "matter come back as duplicates.",
    );
    const disk = await linkOnDisk();
    expect(disk.kind === "ok" && disk.link.matterId).toBe(9);

    // The same selection again: the folder's matter is used, no second one is opened.
    f.calls.length = 0;
    const resumed = await run(handleInitMatter, { selection_id, digest }, f.deps);
    expect(f.calls).toContain("getMatter(9)");
    expect(f.calls).not.toContain("createMatter");
    expect(factsOf(resumed)).toMatchObject({ matter_created: false, matter_id: 9 });

    // And a new scan finds the folder linked.
    const rescan = await run(handleScanProject, { root }, f.deps);
    expect(factsOf(rescan).mode).toBe("linked");
    expect(f.api.createMatter).toHaveBeenCalledTimes(1);
  });

  it("uploads nothing when the link file cannot be written after the create, and says which matter was opened", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fakes({
      writeLink: async () => {
        throw new Error("EACCES: permission denied, mkdir '.dikigoros'");
      },
    });
    const { selection_id, digest } = await confirmed(f, PICKED);
    const result = await run(handleInitMatter, { selection_id, digest }, f.deps);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      `Created matter #9 "${CREATED.title}" (${BASE_URL}/matters/9), but the folder's link file could not be ` +
        "written (EACCES: permission denied, mkdir '.dikigoros'); nothing was uploaded. Upload into matter #9 with " +
        "upload_to_matter, or fix the folder's permissions first: another init_matter here would open a second matter.",
    );
    expect(f.upload).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalled();
  });

  it("keeps uploading when the link file cannot be updated after a file, and warns once", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let writes = 0;
    const f = fakes({
      writeLink: async (real, at, link) => {
        writes += 1;
        if (writes >= 2) throw new Error("ENOSPC: no space left on device");
        return real(at, link);
      },
    });
    const { selection_id, digest } = await confirmed(f, PICKED);
    const result = await run(handleInitMatter, { selection_id, digest }, f.deps);
    expect(f.upload).toHaveBeenCalledTimes(3);
    expect(result.isError).toBeUndefined();
    expect(textOf(result).split("\n").at(-1)).toBe(
      "The folder's link file could not be updated after 3 files (ENOSPC: no space left on device); a later scan " +
        "may offer them again, and their upload would answer duplicate.",
    );
    expect(factsOf(result).link_warning).toBe(textOf(result).split("\n").at(-1));
    expect(errors).toHaveBeenCalledTimes(3);
  });

  it("in a linked folder: creates no matter and uploads into the linked one, its stored names kept apart", async () => {
    await linkFolder();
    const f = fakes({ held: 1 });
    const { selection_id, digest } = await confirmed(f, ["Old/Αγωγή.pdf", "notes.md"], undefined);
    f.calls.length = 0;
    const result = await run(handleInitMatter, { selection_id, digest }, f.deps);

    expect(f.calls).toEqual([
      "getAccessToken",
      "currentUser",
      "getMatter(12)",
      "nativeRuntime",
      "upload(Αγωγή (2).pdf)",
      "upload(notes.md)",
    ]);
    expect(f.upload.mock.calls[0][1].matterId).toBe(12);
    expect(factsOf(result)).toMatchObject({ matter_created: false, matter_id: 12 });
    expect(textOf(result).split("\n")[0]).toBe(`Uploaded into matter #12 "${LINKED.title}", linked to this folder.`);
    const disk = await linkOnDisk();
    if (disk.kind !== "ok") throw new Error("expected a link file");
    expect(disk.link.files.map((file) => [file.relativePath, file.storedName])).toEqual([
      ["Pleadings/Αγωγή.pdf", "Αγωγή.pdf"],
      ["Old/Αγωγή.pdf", "Αγωγή (2).pdf"],
      ["notes.md", "notes.md"],
    ]);
    expect(disk.link.createdAt).toBe("2026-10-01T09:00:00.000Z");
  });

  it("stops when the linked matter is gone since the scan", async () => {
    await linkFolder();
    const f = fakes();
    const { selection_id, digest } = await confirmed(f, ["notes.md"], undefined);
    f.api.getMatter.mockRejectedValueOnce(new ApiError(404, "Matter not found"));
    const result = await run(handleInitMatter, { selection_id, digest }, f.deps);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "The folder's linked matter #12 is gone (or not yours). Nothing was uploaded; scan the folder again to open a new matter.",
    );
    expect(f.upload).not.toHaveBeenCalled();
  });

  it.each([
    ["names another matter", async () => void (await linkFolder({ matterId: 15, url: `${BASE_URL}/matters/15` }))],
    ["is gone", async () => rm(join(root, LINK_DIR), { recursive: true })],
  ])("stops, creating nothing, when a linked folder's link file %s since the scan", async (_what, change) => {
    await linkFolder();
    const f = fakes();
    const { selection_id, digest } = await confirmed(f, ["notes.md"], undefined);
    await change();
    const result = await run(handleInitMatter, { selection_id, digest }, f.deps);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^The folder's link file (now names matter #15, not #12|changed since the scan)/);
    expect(f.api.createMatter).not.toHaveBeenCalled();
    expect(f.upload).not.toHaveBeenCalled();
  });

  it("re-lists (plan_changed) when a selected file's size changed since the selection", async () => {
    const f = fakes();
    const { selection_id, digest } = await confirmed(f, PICKED);
    await appendFile(abs("notes.md"), "Μία γραμμή ακόμη.\n");
    const before = Buffer.byteLength(NOTES);
    const after = (await stat(abs("notes.md"))).size;
    const result = await run(handleInitMatter, { selection_id, digest }, f.deps);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toStrictEqual({
      status: "plan_changed",
      changed: [{ path: "notes.md", size_bytes: before, now_size_bytes: after }],
    });
    expect(textOf(result)).toBe(
      [
        "The files have changed since they were confirmed; nothing was created or uploaded.",
        `notes.md: ${before} B → ${after} B`,
        "Scan the folder again (scan_project) and have the lawyer confirm in the picker again.",
      ].join("\n"),
    );
    expect(f.api.createMatter).not.toHaveBeenCalled();
    expect(f.upload).not.toHaveBeenCalled();
    expect(await linkOnDisk()).toStrictEqual({ kind: "none" });
  });

  it("re-lists a selected file that is gone", async () => {
    const f = fakes();
    const { selection_id, digest } = await confirmed(f, PICKED);
    await rm(abs("notes.md"));
    const result = await run(handleInitMatter, { selection_id, digest }, f.deps);
    expect(result.structuredContent).toStrictEqual({
      status: "plan_changed",
      changed: [{ path: "notes.md", size_bytes: Buffer.byteLength(NOTES), now_size_bytes: null }],
    });
    expect(textOf(result)).toContain("notes.md: gone");
  });

  it("names same-named files Αγωγή.pdf and Αγωγή (2).pdf", async () => {
    const f = fakes();
    const { selection_id, digest } = await confirmed(f, ["Pleadings/Αγωγή.pdf", "Old/Αγωγή.pdf"]);
    await run(handleInitMatter, { selection_id, digest }, f.deps);
    expect(f.upload.mock.calls.map(([entry]) => [entry.path, entry.name])).toEqual([
      [abs("Pleadings/Αγωγή.pdf"), "Αγωγή.pdf"],
      [abs("Old/Αγωγή.pdf"), "Αγωγή (2).pdf"],
    ]);
  });

  it("stops between files when cancelled, as upload_to_matter does, and sends progress", async () => {
    const f = fakes();
    const { selection_id, digest } = await confirmed(f, PICKED);
    const { ctx, notify } = requestContext({ aborted: true, progressToken: "p" });
    const result = await run(handleInitMatter, { selection_id, digest }, f.deps, ctx);
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(textOf(result).split("\n").slice(1, 4)).toEqual([
      "Αγωγή.pdf: ready",
      "Υπεράσπιση.docx: skipped — not started: the call was cancelled",
      "notes.md: skipped — not started: the call was cancelled",
    ]);
    expect(notify).toHaveBeenCalledWith({
      method: "notifications/progress",
      params: { progressToken: "p", progress: 1, message: "Uploading Αγωγή.pdf (1 of 3)" },
    });
    const disk = await linkOnDisk();
    expect(disk.kind === "ok" && disk.link.files.map((file) => file.status)).toEqual(["ready", "skipped", "skipped"]);
  });

  it("starts no file after the 20-minute budget", async () => {
    const f = fakes();
    f.upload.mockImplementationOnce(async (entry) => {
      f.clock.now += CALL_BUDGET_MS + 1;
      return { name: entry.name, status: "ready", documentId: 1 };
    });
    const { selection_id, digest } = await confirmed(f, PICKED);
    const result = await run(handleInitMatter, { selection_id, digest }, f.deps);
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(textOf(result).split("\n")[2]).toMatch(/^Υπεράσπιση\.docx: skipped — not started: this call ran over 20 minutes/);
  });

  it("fails the PDFs alone when the native runtime cannot be installed", async () => {
    const f = fakes({ runtime: new Error("download failed\nstack") });
    const { selection_id, digest } = await confirmed(f, PICKED);
    const result = await run(handleInitMatter, { selection_id, digest }, f.deps);
    expect(f.upload.mock.calls.map(([entry]) => entry.name)).toEqual(["Υπεράσπιση.docx", "notes.md"]);
    expect(textOf(result).split("\n")[1]).toBe("Αγωγή.pdf: failed — download failed");
  });

  it("offers the .gitignore line when the folder is a git repository whose .gitignore does not list .dikigoros", async () => {
    await mkdir(join(root, ".git"));
    const f = fakes();
    const first = await confirmed(f, ["notes.md"]);
    const result = await run(handleInitMatter, { selection_id: first.selection_id, digest: first.digest }, f.deps);
    expect(factsOf(result).gitignore_hint).toBe(true);
    expect(textOf(result)).toContain(
      "This folder is a git repository and its .gitignore does not list .dikigoros/; offer to add it.",
    );

    // Each round uploads another file: the one before is in the matter by then.
    const rounds = [
      [".dikigoros/", "Old/Αγωγή.pdf"],
      ["/.dikigoros", "Pleadings/Αγωγή.pdf"],
      [".dikigoros", "Pleadings/Υπεράσπιση.docx"],
    ];
    for (const [line, path] of rounds) {
      await writeFile(join(root, ".gitignore"), `node_modules/\n${line}\n`);
      const g = fakes();
      const again = await confirmed(g, [path]);
      const listed = await run(handleInitMatter, { selection_id: again.selection_id, digest: again.digest }, g.deps);
      expect(factsOf(listed).gitignore_hint).toBe(false);
    }
  });
});

// ---------- init_matter, the text fallback ----------

describe("init_matter from the text fallback", () => {
  const matter = { title: CREATED.title, type: "civil" as const };

  it("without confirm: lists, uploads nothing, creates nothing, writes nothing", async () => {
    const f = fakes();
    const result = await run(handleInitMatter, { root, relative_paths: ["Pleadings/Αγωγή.pdf", "Old/Αγωγή.pdf"], matter }, f.deps);

    expect(f.calls).toEqual(["getAccessToken", "currentUser", "listMatters"]);
    expect(await linkOnDisk()).toStrictEqual({ kind: "none" });
    const facts = factsOf(result);
    expect(facts).toStrictEqual({
      status: "confirmation_required",
      plan_digest: expect.stringMatching(/^[0-9a-f]{16}$/),
      mode: "new",
      matter: { title: CREATED.title, type: "civil" },
      room: 50,
      files: [
        { path: "Pleadings/Αγωγή.pdf", size_bytes: PDF.length, type: "pdf", stored_name: "Αγωγή.pdf" },
        { path: "Old/Αγωγή.pdf", size_bytes: OLD_PDF.length, type: "pdf", stored_name: "Αγωγή (2).pdf" },
      ],
    });
    expect(textOf(result)).toBe(
      [
        `Nothing has been created or uploaded. Call again with confirm: true and plan_digest "${facts.plan_digest as string}" ` +
          `to open the new matter "${CREATED.title}" and upload the 2 file(s) below.`,
        `Pleadings/Αγωγή.pdf · ${formatSize(PDF.length)} · pdf`,
        `Old/Αγωγή.pdf · ${formatSize(OLD_PDF.length)} · pdf · stored as Αγωγή (2).pdf`,
        `New matter: "${CREATED.title}" (type civil)`,
      ].join("\n"),
    );
  });

  it("confirm: true without the plan_digest only lists", async () => {
    const f = fakes();
    const result = await run(handleInitMatter, { root, relative_paths: PICKED, matter, confirm: true }, f.deps);
    expect(factsOf(result).status).toBe("confirmation_required");
    expect(f.api.createMatter).not.toHaveBeenCalled();
    expect(f.upload).not.toHaveBeenCalled();
  });

  it("a confirmed call whose matter fields differ from the listing's lists again and creates nothing", async () => {
    const f = fakes();
    const listing = await run(handleInitMatter, { root, relative_paths: PICKED, matter }, f.deps);
    const plan_digest = factsOf(listing).plan_digest as string;
    f.calls.length = 0;
    const changed = { ...matter, title: `${matter.title} (changed)` };
    const result = await run(
      handleInitMatter,
      { root, relative_paths: PICKED, matter: changed, confirm: true, plan_digest },
      f.deps,
    );

    expect(factsOf(result)).toMatchObject({ status: "plan_changed" });
    expect(factsOf(result).plan_digest).not.toBe(plan_digest);
    expect(f.calls).not.toContain("createMatter");
    expect(f.calls.some((call) => call.startsWith("upload("))).toBe(false);
  });

  it("with confirm and the listing's plan_digest: creates and uploads", async () => {
    const f = fakes();
    const listing = await run(handleInitMatter, { root, relative_paths: PICKED, matter }, f.deps);
    const plan_digest = factsOf(listing).plan_digest as string;
    f.calls.length = 0;
    const result = await run(handleInitMatter, { root, relative_paths: PICKED, matter, confirm: true, plan_digest }, f.deps);

    expect(f.calls).toEqual([
      "getAccessToken",
      "currentUser",
      "listMatters",
      "createMatter",
      "nativeRuntime",
      "upload(Αγωγή.pdf)",
      "upload(Υπεράσπιση.docx)",
      "upload(notes.md)",
    ]);
    expect(factsOf(result)).toMatchObject({ status: "done", matter_created: true, matter_id: 9 });
    const disk = await linkOnDisk();
    expect(disk.kind === "ok" && disk.link.files.length).toBe(3);
  });

  it("re-lists (plan_changed) when the files changed since the listing", async () => {
    const f = fakes();
    const listing = await run(handleInitMatter, { root, relative_paths: PICKED, matter }, f.deps);
    const plan_digest = factsOf(listing).plan_digest as string;
    await appendFile(abs("notes.md"), "Μία γραμμή ακόμη.\n");
    const result = await run(handleInitMatter, { root, relative_paths: PICKED, matter, confirm: true, plan_digest }, f.deps);
    expect(factsOf(result).status).toBe("plan_changed");
    expect(factsOf(result).plan_digest).not.toBe(plan_digest);
    expect(textOf(result).split("\n")[0]).toBe("The files have changed since they were listed.");
    expect(f.api.createMatter).not.toHaveBeenCalled();
  });

  it("uploads into the linked matter in a linked folder, its matter fields ignored", async () => {
    await linkFolder();
    const f = fakes({ held: 1 });
    const listing = await run(handleInitMatter, { root, relative_paths: ["notes.md"], matter }, f.deps);
    expect(factsOf(listing)).toMatchObject({
      mode: "linked",
      linked_matter: { id: 12, title: LINKED.title, url: `${BASE_URL}/matters/12` },
    });
    expect(factsOf(listing)).not.toHaveProperty("matter");
    expect(textOf(listing).split("\n").at(-1)).toBe(`Matter #12 "${LINKED.title}": 1 of 50 documents`);
    const plan_digest = factsOf(listing).plan_digest as string;
    const result = await run(handleInitMatter, { root, relative_paths: ["notes.md"], confirm: true, plan_digest }, f.deps);
    expect(f.api.createMatter).not.toHaveBeenCalled();
    expect(factsOf(result)).toMatchObject({ matter_created: false, matter_id: 12 });
  });

  it.each([
    [
      "an over-room list",
      { docsPerMatter: 2 },
      PICKED,
      "3 files are more than the 2 this matter has room for in one call.",
    ],
    ["an ineligible path", {}, ["photo.jpg"], "photo.jpg cannot be uploaded (unsupported_type)."],
    ["a path outside the scan", {}, ["../elsewhere/Αγωγή.pdf"], "../elsewhere/Αγωγή.pdf is not in the scan."],
    ["a path given twice", {}, ["notes.md", "notes.md"], "notes.md is named twice."],
  ])("refuses %s", async (_what, entitlements, relative_paths, sentence) => {
    const f = fakes({ me: { ...ME, entitlements: { ...ME.entitlements, ...entitlements } } });
    const result = await run(handleInitMatter, { root, relative_paths, matter, confirm: true, plan_digest: "x" }, f.deps);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(sentence);
    expect(f.api.createMatter).not.toHaveBeenCalled();
    expect(f.upload).not.toHaveBeenCalled();
  });

  it("refuses a new matter without a title", async () => {
    const f = fakes();
    const result = await run(handleInitMatter, { root, relative_paths: ["notes.md"] }, f.deps);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(SENTENCES.title_required);
  });

  it("answers the active-matter limit when 10 of 10 are open, and creates nothing", async () => {
    const f = fakes({ matters: openMatters(10) });
    const result = await run(handleInitMatter, { root, relative_paths: ["notes.md"], matter }, f.deps);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("10 of 10 active matters");
    expect(f.api.createMatter).not.toHaveBeenCalled();
  });

  it.each([
    ["neither shape", {}],
    ["a selection_id without its digest", { selection_id: "abc" }],
    ["both shapes", { selection_id: "abc", digest: "d", root: "/x", relative_paths: ["a.pdf"] }],
    ["a root without relative_paths", { root: "/x" }],
  ])("refuses %s before anything else", async (_what, args) => {
    const f = fakes();
    const result = await run(handleInitMatter, args, f.deps);
    expect(result).toStrictEqual({
      content: [
        {
          type: "text",
          text:
            "Call init_matter either with selection_id and digest (from the picker) or with root and relative_paths " +
            "(the text fallback), not both.",
        },
      ],
      isError: true,
    });
    expect(f.calls).toEqual([]);
  });
});

// ---------- registration ----------

describe("registerInitTools", () => {
  async function connected(deps: InitToolDeps = fakes().deps) {
    const server = new McpServer({ name: "test", version: "0" });
    registerInitTools(server, deps);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test-client", version: "0" });
    await client.connect(clientSide);
    return client;
  }

  it("lists the five tools with titles, operational descriptions and explicit boolean annotations", async () => {
    const client = await connected();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "scan_project",
      "show_project_picker",
      "load_picker",
      "save_selection",
      "init_matter",
    ]);
    const hints: Record<string, [boolean, boolean]> = {
      scan_project: [true, true],
      show_project_picker: [true, false],
      load_picker: [true, true],
      save_selection: [false, false],
      init_matter: [false, false],
    };
    for (const tool of tools) {
      expect(tool.title).toBeTruthy();
      expect(tool.description).toMatch(/^Use this when /);
      expect(tool.description).toMatch(/ Not for [^.]+\.$/);
      const [readOnlyHint, idempotentHint] = hints[tool.name];
      expect(tool.annotations).toStrictEqual({
        readOnlyHint,
        destructiveHint: false,
        idempotentHint,
        openWorldHint: false,
      });
    }
    await client.close();
  });

  it("links show_project_picker to the picker for the model and the app, under both keys", async () => {
    const client = await connected();
    const { tools } = await client.listTools();
    const show = tools.find((tool) => tool.name === "show_project_picker");
    expect(show?._meta).toStrictEqual({ ui: { resourceUri: PICKER_URI }, [RESOURCE_URI_META_KEY]: PICKER_URI });
    for (const name of ["scan_project", "init_matter"]) {
      expect(tools.find((tool) => tool.name === name)?._meta).toBeUndefined();
    }
    await client.close();
  });

  it.each(["load_picker", "save_selection"])("lists %s with visibility ['app'] only", async (name) => {
    const client = await connected();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === name);
    expect(tool?._meta).toStrictEqual({
      ui: { resourceUri: PICKER_URI, visibility: ["app"] },
      [RESOURCE_URI_META_KEY]: PICKER_URI,
    });
    expect(tool?.description).toContain("For the picker only");
    await client.close();
  });

  it("gives init_matter one object schema with every field optional, not a union", async () => {
    const client = await connected();
    const { tools } = await client.listTools();
    const schema = tools.find((tool) => tool.name === "init_matter")?.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema).not.toHaveProperty("anyOf");
    expect(schema).not.toHaveProperty("oneOf");
    expect(Object.keys(schema.properties as object).sort()).toEqual(
      ["confirm", "digest", "matter", "plan_digest", "relative_paths", "root", "selection_id"].sort(),
    );
    expect(schema.required ?? []).toEqual([]);
    await client.close();
  });

  it("answers save_selection's refusals over the wire as structured content, an empty list included", async () => {
    const f = fakes();
    const scan_id = await scanned(f);
    const client = await connected(f.deps);
    const empty = await client.callTool({ name: "save_selection", arguments: { scan_id, relative_paths: [] } });
    expect(empty.isError).toBe(true);
    expect(empty.structuredContent).toStrictEqual({ refused: "empty_selection" });
    const blank = await client.callTool({
      name: "save_selection",
      arguments: { scan_id, relative_paths: ["notes.md"], matter: { title: " " } },
    });
    expect(blank.structuredContent).toStrictEqual({ refused: "title_required" });
    const loaded = await client.callTool({ name: "load_picker", arguments: { scan_id } });
    expect((loaded.structuredContent as PickerInput).scan_id).toBe(scan_id);
    await client.close();
  });

  it("serves the HTML with mimeType text/html;profile=mcp-app and an empty CSP", async () => {
    const client = await connected();
    const { resources } = await client.listResources();
    expect(resources).toStrictEqual([
      expect.objectContaining({
        uri: PICKER_URI,
        name: "DIKIGOROS project picker",
        mimeType: RESOURCE_MIME_TYPE,
        _meta: { ui: { csp: {} } },
      }),
    ]);
    const read = await client.readResource({ uri: PICKER_URI });
    expect(RESOURCE_MIME_TYPE).toBe("text/html;profile=mcp-app");
    expect(read.contents).toStrictEqual([
      {
        uri: PICKER_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: "<!doctype html><html><body><script>/* picker */</script></body></html>",
        _meta: { ui: { csp: {} } },
      },
    ]);
    await client.close();
  });

  it("offers the picker the same matter types as create_matter", () => {
    expect([...PICKER_MATTER_TYPES]).toEqual([...MATTER_TYPES]);
  });
});
