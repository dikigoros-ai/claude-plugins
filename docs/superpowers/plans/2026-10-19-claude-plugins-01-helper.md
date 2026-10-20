# DIKIGOROS Claude plugin + local upload helper — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `dikigoros` Claude plugin (marketplace + manifest) whose bundled stdio MCP server `dikigoros-upload` signs a lawyer in with the Auth0 device grant and uploads local PDF/DOCX/TXT/MD files into a DIKIGOROS matter through the same REST routes and pipeline the web uploader uses, after an explicit confirm step.

**Architecture:** TypeScript sources under `src/` are bundled by esbuild into one ESM file at `plugins/dikigoros/server/dikigoros-upload.mjs` (committed, with pdf.js's worker, wasm decoders and standard fonts beside it). The two native components (`@napi-rs/canvas` for rasterising scanned pages, `@napi-rs/keyring` for the OS keychain) are 27–37 MB per platform and cannot live in git, so the bundle installs their exact pinned npm tarballs (sha512-verified against a committed lock) into the plugin data directory on first use. Every network dependency is injected (`fetchImpl`, a fake HTTP API in tests), so the suite runs offline; the live pass is a gate for the owner and counsel.

**Tech Stack:** Node ≥ 22.13 (pdf.js floor), `@modelcontextprotocol/server` 2.3.1 (`serveStdio`), zod 4, `pdfjs-dist` 6.4.299 (legacy build) + `@napi-rs/canvas` 1.0.11, `mammoth` 1.13.0, `@vercel/blob` 2.8.2 (client `put`), `@napi-rs/keyring` 2.1.2, `tar` 7, esbuild, vitest, eslint + typescript-eslint.

**Spec:** `docs/superpowers/specs/2026-10-19-mcp-server-design.md` in the main repository `dikigoros-ai/dikigoros-ai`, branch `feat/mcp-connector-01-foundation` (from a checkout of that repository, read it with `git show feat/mcp-connector-01-foundation:docs/superpowers/specs/2026-10-19-mcp-server-design.md`). §5.6 is this plan's section; §4.2 (the REST allowlist), §5.5, §7.2, §9 row 5 and §12 constrain it. Appendix A of this plan carries the §5.6 text and the allowlist verbatim.

## Global Constraints

- Node `>=22.13.0` (`engines` in package.json; pdfjs-dist 6 requires it). Bundle target `node22`, ESM.
- The plugin root `plugins/dikigoros/` has **no top-level `bin/` directory** (claude.ai and Cowork refuse plugins with one). Server files live in `plugins/dikigoros/server/`.
- The helper talks only to `https://dikigoros.ai` or `http://localhost:3000` (`ALLOWED_ORIGINS`); any other `DIKIGOROS_BASE_URL` makes the process print one line to stderr and exit 1.
- Auth0 device authorization grant; audience `${baseUrl}/mcp` (`https://dikigoros.ai/mcp`, dev `http://localhost:3000/mcp`); scopes requested: `openid offline_access matters:read matters:write account:read`.
- The refresh token is stored only in the OS keychain (`@napi-rs/keyring`, service `dikigoros-upload-helper`, account = base URL); never written to disk in plaintext; the access token lives in process memory only. No token, code or `Authorization` value is ever logged, returned in a tool result, or included in an error message.
- Every REST call carries `Authorization: Bearer <access token>`; the same bearer goes to the blob-token route.
- Accept list `MATTER_UPLOAD_ACCEPT = ".pdf,.docx,.txt,.md"`; `MAX_FILE_BYTES = 50 * 1024 * 1024`; `MAX_TEXT_DOCUMENT_CHARS = 200_000`; dotfiles skipped; a candidate whose real path escapes the named directory is skipped; `docsPerMatter` enforced before any upload.
- Uploads happen only on a second call carrying `confirm: true`; the first call echoes the resolved list (name, size, type, decision) and uploads nothing.
- Tool names snake_case ≤ 64 chars; every tool has `title`, `description` starting "Use this when…" and ending with what it is not for, explicit boolean annotations (`readOnlyHint`, `destructiveHint: false`, `idempotentHint`, `openWorldHint: false`); no instruction to the model, no promotion, no legal know-how anywhere in the repo (spec §7.6).
- stdout is the JSON-RPC channel: logging goes through `console.error` only.
- Ported code from the main repo carries a provenance comment naming the source file and commit `37f39ac5` (`dikigoros-ai/dikigoros-ai`, 2026-10-19). Sharing the extraction module as a package is a recorded follow-up, not this PR.
- Commit messages: conventional prefix, imperative headline, never `[preview]` in the headline, body ends with a blank line and `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Subagents commit locally only; no `gh`, no network, no `npm install` (the controller installs every dependency in Task 1).
- Versions are pinned: `plugins/dikigoros/.claude-plugin/plugin.json` `version`, the marketplace entry `version` and `package.json` `version` move together (`0.1.0` for this PR).

## Review Focus

1. A relative path, `~/…`, or a path with a trailing slash in `paths[]` — the stdio server's working directory is unknown, so the helper refuses non-absolute paths with reason `not_absolute` rather than resolving against cwd (Task 3 test "refuses a relative path").
2. A filename with Greek letters or spaces — the blob pathname is `${prefix}${name}` verbatim (the client encodes it; the server's `isOwnBlobUrl` decodes it); the fake store must echo it back unchanged (Task 8 test "keeps a Greek filename with spaces in the pathname", Task 16 asserts the registered `blobUrl`).
3. The access token expiring during a long OCR poll — one 401 triggers a refresh and a retry of that request; a second 401 ends the document as `failed` with code `unauthorized` and the sign-in instructions (Task 7 test "retries once after a 401", Task 12 test "a 401 mid-poll is refreshed once").
4. A scan whose pages render blank (`no_text_extracted`) — the original is already in the store, as in the browser; the document is reported `failed` with that code and no `createDocument` call is made (Task 12 test).
5. The same file named twice (directly and through its directory) or a `.txt` in windows-1253 — deduplicated by real path (Task 3 test "deduplicates by real path"); decoded through the windows-1253 fallback, undecodable bytes skipped as `text_encoding` (Task 2 test, Task 12 test).

---

## File structure

```
.claude-plugin/marketplace.json                  marketplace "dikigoros-ai", one plugin entry → ./plugins/dikigoros
plugins/dikigoros/.claude-plugin/plugin.json     name "dikigoros", version, two mcpServers (remote http + local stdio)
plugins/dikigoros/server/dikigoros-upload.mjs    the esbuild bundle (committed)
plugins/dikigoros/server/pdf.worker.min.mjs      copied from pdfjs-dist/legacy/build
plugins/dikigoros/server/wasm/                   jbig2.wasm, openjpeg.wasm, qcms_bg.wasm + LICENSE_* (pdfjs-dist/wasm)
plugins/dikigoros/server/standard_fonts/         pdfjs-dist/standard_fonts
plugins/dikigoros/server/dikigoros-upload.mjs.LEGAL.txt   esbuild legal comments of the bundled packages
src/config.ts                                    env → HelperConfig; origin allowlist
src/files/resolve.ts                             paths[] → upload plan (accept list, sizes, dotfiles, symlink containment, digest)
src/extract/classify.ts                          classifyPage, joinPdfTextItems, isBlankRaster (ported)
src/extract/sniff.ts                             sniffFileKind, headBytesBase64 (ported)
src/extract/text.ts                              decodeTextBytes, normalizeTextDocument, storableText (ported)
src/extract/docx.ts                              extractDocx (mammoth)
src/extract/pdf.ts                               extractPdf in Node (pdfjs legacy + canvas factory)
src/native/platform.ts                           platformKey()
src/native/install.ts                            ensureNativeRuntime (download, verify, extract, atomic rename)
src/native/load.ts                               loadCanvasModule, loadKeyringBinding (createRequire)
src/native/lock.generated.json                   pinned tarball URLs + sha512 integrity (written by scripts/pin-native.ts)
src/auth/token-store.ts                          TokenStore, MemoryTokenStore, KeyringTokenStore, createTokenStore
src/auth/device-flow.ts                          requestDeviceCode, pollDeviceToken, refreshAccessToken
src/auth/session.ts                              AuthSession (access token cache, background device poll)
src/auth/open-browser.ts                         best-effort browser open (spawn open / start / xdg-open)
src/api/errors.ts                                ApiError, describeApiError
src/api/client.ts                                DikigorosApi (the REST routes) + response types
src/api/blob-upload.ts                           requestClientToken + put() to the private store
src/pipeline/upload-document.ts                  one document end to end (hash → blob → extract → create → ingest → poll)
src/server/tools.ts                              registerTools(server, deps): upload_to_matter, create_matter
src/server/assets.ts                             resolveAssets(bundleUrl) → worker/wasm/fonts locations
src/server/main.ts                               wiring + serveStdio
scripts/build.ts                                 esbuild + asset copy
scripts/pin-native.ts                            npm view → lock.generated.json (network; controller only)
test/support/fake-api.ts                         in-memory DIKIGOROS API + blob store over http
test/support/pdf-fixtures.ts                     hand-written PDF generators (text layer, image page, blank page)
test/support/docx-fixture.ts                     minimal .docx via jszip
test/integration/upload-flow.test.ts             whole flow against the fake API
test/plugin-manifest.test.ts, test/plugin-smoke.test.ts
docs/assumed-routes.md, docs/release-process.md, README.md, LICENSE, CHANGELOG.md
.github/workflows/ci.yml
```

---

### Task 1: Repository scaffold, dependencies, CI (controller executes — needs the network)

**Files:**
- Create: `package.json`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`, `.gitignore`, `.npmrc`, `LICENSE`, `.github/workflows/ci.yml`, `scripts/pin-native.ts`, `src/native/lock.generated.json`, `test/scaffold.test.ts`

**Interfaces:**
- Produces: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` (build script lands in Task 14; the script entry exists from the start), `npm run pin-native`; `node_modules/` holding every dependency later tasks import.

- [ ] **Step 1: Write `package.json`**

`"name": "@dikigoros-ai/claude-plugins"`, `"version": "0.1.0"`, `"private": true`, `"type": "module"`, `"engines": { "node": ">=22.13.0" }`, scripts: `lint` = `eslint .`, `typecheck` = `tsc --noEmit`, `test` = `vitest run`, `build` = `tsx scripts/build.ts`, `pin-native` = `tsx scripts/pin-native.ts`, `check` = `npm run lint && npm run typecheck && npm test`. Dependencies (exact versions): `@modelcontextprotocol/server@2.3.1`, `zod@4.6.7`, `pdfjs-dist@6.4.299`, `mammoth@1.13.0`, `@vercel/blob@2.8.2`, `tar@7.5.22`. Dev: `typescript` (latest 5.x), `vitest@5.0.5`, `esbuild@0.28.2`, `tsx@4.21.0`, `eslint@9`, `typescript-eslint@8`, `@types/node@22`, `@napi-rs/canvas@1.0.11`, `@napi-rs/keyring@2.1.2`, `jszip@3`.

- [ ] **Step 2: Write `tsconfig.json`**

`target ES2022`, `module ESNext`, `moduleResolution bundler`, `strict true`, `noEmit true`, `types ["node"]`, `resolveJsonModule true`, `skipLibCheck true`, `include ["src", "test", "scripts"]`, `exclude ["node_modules", "plugins"]`.

- [ ] **Step 3: Write `vitest.config.ts`, `eslint.config.mjs`, `.gitignore`, `.npmrc`, `LICENSE`**

vitest: `environment: "node"`, `include: ["src/**/*.test.ts", "test/**/*.test.ts"]`, `testTimeout: 60_000`. eslint: `typescript-eslint` recommended, `globalIgnores(["plugins/**/server/**", "node_modules/**"])`. `.gitignore`: `node_modules/`, `dist/`, `.DS_Store`, `authorized_tokens.json`, `*.local`, `.env*`. `.npmrc`: `save-exact=true`. LICENSE: MIT, `Copyright (c) 2026 DIKIGOROS AI`.

- [ ] **Step 4: Write `.github/workflows/ci.yml`**

On `push` and `pull_request`: `actions/checkout@v4`, `actions/setup-node@v4` with `node-version: 22`, `cache: npm`; `npm ci`; `npm run lint`; `npm run typecheck`; `npm run build`; `npm test`; `git diff --exit-code -- plugins/` (the committed bundle must match a fresh build).

- [ ] **Step 5: Write `scripts/pin-native.ts` and run it**

For `@napi-rs/canvas@1.0.11`, `@napi-rs/keyring@2.1.2` and their platform packages for keys `darwin-arm64`, `darwin-x64`, `linux-x64-gnu`, `linux-arm64-gnu`, `win32-x64-msvc`, `win32-arm64-msvc` (package names `@napi-rs/canvas-<key>`, `@napi-rs/keyring-<key>`), run `npm view <name>@<version> --json dist.tarball dist.integrity` and write `src/native/lock.generated.json`:

```json
{ "version": 1,
  "packages": { "@napi-rs/canvas": { "version": "1.0.11", "tarball": "https://registry.npmjs.org/…", "integrity": "sha512-…" }, … },
  "platforms": { "darwin-arm64": { "canvas": "@napi-rs/canvas-darwin-arm64", "keyring": "@napi-rs/keyring-darwin-arm64" }, … } }
```

Run: `npm run pin-native` → the file exists, 14 package entries, every `integrity` starts with `sha512-`.

- [ ] **Step 6: Install and verify the toolchain**

Run: `npm install` then `npm run lint && npm run typecheck && npm test` with `test/scaffold.test.ts` (`expect(1 + 1).toBe(2)`). Expected: all three pass.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "chore: scaffold the plugin repository (toolchain, CI, native lock)"
```

---

### Task 2: Ported extraction primitives (classify, sniff, text)

**Files:**
- Create: `src/extract/classify.ts`, `src/extract/sniff.ts`, `src/extract/text.ts`
- Test: `src/extract/classify.test.ts`, `src/extract/sniff.test.ts`, `src/extract/text.test.ts`
- Source to copy from (read-only): the main repository's `lib/matter-extract.ts` (`classifyPage`, `PdfTextItemLike`, `fontSizeOf`, `joinPdfTextItems`, `isBlankRaster` and their constants), `lib/matter-blob.ts` (`sniffFileKind`), `lib/text-file-decode.ts` (`decodeTextBytes`), `lib/matters.ts` (`storableText`, `normalizeTextDocument`, `MAX_TEXT_DOCUMENT_CHARS`), and the matching cases of `lib/matter-extract.test.ts`.

**Interfaces:**
- Produces: `classifyPage(text: string): { needsOcr: boolean }`; `joinPdfTextItems(items: readonly PdfTextItemLike[]): string`; `isBlankRaster(rgba: Uint8ClampedArray | Uint8Array): boolean`; `sniffFileKind(bytes: Uint8Array): "pdf" | "docx" | null`; `headBytesBase64(bytes: Uint8Array): string` (base64 of the first 8 bytes); `decodeTextBytes(bytes: Uint8Array): string | null`; `normalizeTextDocument(raw: string): string`; `storableText(text: string): string`; `MAX_TEXT_DOCUMENT_CHARS = 200_000`.

- [ ] **Step 1: Write the failing tests**

Port every `classifyPage`, `joinPdfTextItems` and `isBlankRaster` case from the main repo's `lib/matter-extract.test.ts` (not the `pdfDocumentOptions` cases). Add:

```ts
// sniff.test.ts
it("recognises %PDF- and PK\\x03\\x04 and nothing else", () => {
  expect(sniffFileKind(new TextEncoder().encode("%PDF-1.7\n"))).toBe("pdf");
  expect(sniffFileKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe("docx");
  expect(sniffFileKind(new TextEncoder().encode("hello"))).toBeNull();
});
it("headBytesBase64 encodes exactly the first 8 bytes", () => {
  expect(headBytesBase64(new TextEncoder().encode("%PDF-1.7\nmore"))).toBe(Buffer.from("%PDF-1.7").toString("base64"));
});
// text.test.ts
it("decodes UTF-8 and strips the BOM", ...);
it("falls back to windows-1253 for a legacy Greek export", () => {
  const bytes = new Uint8Array([0xc1, 0xe3, 0xf9, 0xe3, 0xde]); // «Αγωγή» in windows-1253
  expect(decodeTextBytes(bytes)).toBe("Αγωγή");
});
it("returns null when neither decoding is clean", () => expect(decodeTextBytes(new Uint8Array([0xff, 0xfe, 0xfd]))).toBeNull());
it("normalizeTextDocument strips BOM, CRLF and trims; storableText replaces U+0000", ...);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/extract` — Expected: FAIL (modules missing).

- [ ] **Step 3: Copy the functions**

Each file opens with: `// Ported verbatim from dikigoros-ai/dikigoros-ai <path> @ 37f39ac5 (2026-10-19). Environment-neutral; sharing it as a package is a follow-up.` Keep bodies byte-identical except: `decodeTextBytes` takes `Uint8Array`; `sniffFileKind` is unchanged; no `window`, no browser imports.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/extract` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extract && git commit -m "feat(extract): port classifyPage, joinPdfTextItems, isBlankRaster, sniff and text decoding"
```

---

### Task 3: Upload plan resolution (paths → files, skips, digest)

**Files:**
- Create: `src/files/resolve.ts`
- Test: `src/files/resolve.test.ts`

**Interfaces:**
- Consumes: `sniffFileKind` (Task 2).
- Produces:

```ts
export const MATTER_UPLOAD_ACCEPT = ".pdf,.docx,.txt,.md";
export const MATTER_UPLOAD_EXT_RE = /\.(pdf|docx|txt|md)$/i;
export const TEXT_DOCUMENT_EXT_RE = /\.(txt|md)$/i;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_PATHS_PER_CALL = 50;
export const MAX_FILES_PER_CALL = 100;
export type FileKind = "pdf" | "docx" | "text";
export type SkipReason = "not_absolute" | "not_found" | "unreadable" | "not_a_file" | "dotfile" | "unsupported_type" | "too_large" | "empty" | "outside_directory" | "duplicate_path" | "too_many_files";
export interface PlanEntry { path: string; realPath: string; name: string; sizeBytes: number; kind: FileKind | null; decision: "upload" | "skip"; reason?: SkipReason }
export interface UploadPlan { entries: PlanEntry[]; digest: string; emptyPaths: string[] /* named paths that produced no entry at all, e.g. a folder holding only subfolders or dotfiles */ }
export async function resolveUploadPlan(paths: string[]): Promise<UploadPlan>;
export function planDigest(entries: PlanEntry[]): string; // sha256 over the sorted "realPath\0sizeBytes" of upload entries, first 16 hex chars
```

- [ ] **Step 1: Write the failing tests** (each builds a tree under `fs.mkdtemp`)

```ts
it("lists the top-level files of a directory, skipping dotfiles and subdirectories");
it("accepts a directly named file and keeps its name verbatim (Greek, spaces)");
it("refuses a relative path", async () => expect((await resolveUploadPlan(["docs/a.pdf"])).entries[0]).toMatchObject({ decision: "skip", reason: "not_absolute" }));
it("skips a file outside the accept list and a file whose magic bytes contradict its .pdf extension (unsupported_type)");
it("skips a file over MAX_FILE_BYTES (too_large) and an empty file (empty)"); // use fs.truncate to size a sparse file to 50 MB + 1
it("skips a symlink whose real path leaves the named directory (outside_directory) and keeps one that stays inside");
it("deduplicates by real path when a file is named directly and through its directory (duplicate_path)");
it("caps the upload list at MAX_FILES_PER_CALL (too_many_files)");
it("digest changes when a planned file's size changes and ignores skipped entries");
it("an empty .pdf is `empty`, not `unsupported_type`");
it("a file or folder the process may not read is `unreadable` (EACCES), while a missing one is `not_found`"); // chmod 000; skipped when running as root
it("a folder holding only subfolders or dotfiles yields no entries and is listed in emptyPaths");
it("a .txt the process may not read is skipped as `unreadable`, not planned for upload");
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/files` → FAIL.

- [ ] **Step 3: Implement `resolveUploadPlan`**

Rules, in order per input path: `path.isAbsolute` else `not_absolute`; `stat`: `ENOENT`/`ENOTDIR`/`ELOOP` → `not_found`, `EACCES`/`EPERM` → `unreadable` (branch on `err.code`; any other code → `unreadable`); a directory → its `readdir({ withFileTypes: true })` children that are files or symlinks to files, **omitting names that start with `.` silently** (they are not entries; `.DS_Store` and `._x` twins never reach the lawyer's table), sorted by name; a directory `readdir` that fails → `unreadable`; a file → itself with the named directory = `dirname(path)`; child paths are built by string concatenation (`directory + sep + name`), never `path.join`, so a `..` the caller wrote is seen by the OS, not collapsed; for every candidate `realpath(candidate)` must start with `realpath(namedDirectory) + sep` else `outside_directory`; `name = basename(path as given)`; a directly named dotfile → `dotfile`; extension outside `MATTER_UPLOAD_EXT_RE` → `unsupported_type`; `size === 0` → `empty`; `size > MAX_FILE_BYTES` → `too_large`; then open the file and read its first 8 bytes for **every** kind (an open that fails → `unreadable`), and for `.pdf`/`.docx` require `sniffFileKind` to match the extension else `unsupported_type`; a real path already planned → `duplicate_path`; more than `MAX_FILES_PER_CALL` upload entries → the rest `too_many_files`. Kind: `pdf` for `.pdf`, `docx` for `.docx`, `text` for `.txt`/`.md`, null otherwise (explicit map, no fall-through). Entries keep input order. A named path that produced no entry at all (a folder of subfolders or dotfiles) goes into `emptyPaths`.

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/files` → PASS.

- [ ] **Step 5: Commit** — `git add src/files && git commit -m "feat(files): resolve upload plans with accept list, size caps and symlink containment"`

---

### Task 4: Configuration and the origin allowlist

**Files:**
- Create: `src/config.ts`
- Test: `src/config.test.ts`

**Interfaces:**
- Produces:

```ts
export const ALLOWED_ORIGINS = ["https://dikigoros.ai", "http://localhost:3000"] as const;
export const DEVICE_SCOPES = "openid offline_access matters:read matters:write account:read";
export interface HelperConfig { baseUrl: string; audience: string; auth0Domain: string; auth0ClientId: string; scopes: string; dataDir: string; openBrowser: boolean; nativeDirOverride: string | null }
export class ConfigError extends Error {}
export function loadConfig(env: NodeJS.ProcessEnv, homeDir: string): HelperConfig;
```

Env: `DIKIGOROS_BASE_URL` (default `https://dikigoros.ai`; trailing slash stripped; must be in `ALLOWED_ORIGINS` byte for byte after stripping, else `ConfigError("DIKIGOROS_BASE_URL must be one of …")`), `DIKIGOROS_AUTH0_DOMAIN` (default `dikigoros-prod.eu.auth0.com` for the production origin, `dikigoros-staging.eu.auth0.com` for localhost), `DIKIGOROS_AUTH0_CLIENT_ID` (default `""` = unconfigured), `CLAUDE_PLUGIN_DATA` → `dataDir` (default `join(homeDir, ".dikigoros", "helper")`), `DIKIGOROS_NO_BROWSER` (`"1"` → `openBrowser: false`), `DIKIGOROS_HELPER_NATIVE_DIR` → `nativeDirOverride`. `audience = baseUrl + "/mcp"`.

- [ ] **Step 1: Write the failing tests** — defaults; localhost; `https://dikigoros.ai/` normalised; `https://dikigoros.example.vercel.app` → throws `ConfigError`; `http://localhost:3001` → throws; `CLAUDE_PLUGIN_DATA` honoured; `DIKIGOROS_NO_BROWSER=1`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement `loadConfig`.**
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(config): env-driven configuration with the two allowed origins"`

---

### Task 5: Token store (keychain with in-memory fallback)

**Files:**
- Create: `src/auth/token-store.ts`
- Test: `src/auth/token-store.test.ts`

**Interfaces:**
- Produces:

```ts
export const KEYRING_SERVICE = "dikigoros-upload-helper";
export interface TokenStore { readonly kind: "keyring" | "memory"; get(account: string): Promise<string | null>; set(account: string, secret: string): Promise<void>; delete(account: string): Promise<void> }
export interface KeyringEntryLike { getPassword(): string | null; setPassword(password: string): void; deletePassword(): boolean }
export interface KeyringBinding { Entry: new (service: string, account: string) => KeyringEntryLike }
export class MemoryTokenStore implements TokenStore {}
export class KeyringTokenStore implements TokenStore { constructor(binding: KeyringBinding, service?: string) }
export async function createTokenStore(loadBinding: () => Promise<KeyringBinding>): Promise<{ store: TokenStore; warning: string | null }>;
```

`createTokenStore` returns the keyring store when `loadBinding()` resolves and a probe (`new Entry(service, "__probe__").getPassword()`) does not throw; otherwise a `MemoryTokenStore` with `warning = "The OS keychain is not available on this machine (<reason>); the sign-in is kept in memory for this session only."`. The reason is the error's `message`, never anything else.

- [ ] **Step 1: Write the failing tests** — memory round trip; keyring round trip against a fake binding (Map-backed `Entry`); `delete` of a missing account resolves; `createTokenStore` picks keyring when the binding works, memory with the warning when `loadBinding` rejects, memory when the probe throws.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(auth): keychain token store with an in-memory fallback"`

---

### Task 6: Device authorization grant and the auth session

**Files:**
- Create: `src/auth/device-flow.ts`, `src/auth/session.ts`, `src/auth/open-browser.ts`
- Test: `src/auth/device-flow.test.ts`, `src/auth/session.test.ts`

**Interfaces:**
- Consumes: `HelperConfig` (Task 4), `TokenStore` (Task 5).
- Produces:

```ts
// device-flow.ts
export interface DeviceCodeResponse { device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; expires_in: number; interval: number }
export interface TokenResponse { access_token: string; refresh_token?: string; expires_in: number; scope?: string; token_type: string }
export class DeviceFlowError extends Error { constructor(public code: string, message: string) }
export type FetchLike = typeof fetch;
export async function requestDeviceCode(cfg: Pick<HelperConfig, "auth0Domain" | "auth0ClientId" | "scopes" | "audience">, fetchImpl: FetchLike): Promise<DeviceCodeResponse>;
export async function pollDeviceToken(cfg, device: DeviceCodeResponse, deps: { fetchImpl: FetchLike; sleep: (ms: number) => Promise<void>; now: () => number }): Promise<TokenResponse>;
export async function refreshAccessToken(cfg, refreshToken: string, fetchImpl: FetchLike): Promise<TokenResponse>;
// session.ts
export interface SignInPrompt { verificationUriComplete: string; verificationUri: string; userCode: string; expiresInSeconds: number }
export type SessionStatus = "signed_out" | "pending" | "signed_in";
export class AuthSession {
  constructor(deps: { config: HelperConfig; store: () => Promise<TokenStore>; fetchImpl: FetchLike; sleep; now: () => number; openBrowser: (url: string) => void; log: (line: string) => void });
  status(): SessionStatus;
  getAccessToken(): Promise<string | null>;   // cached if > 60 s left; else refresh from the stored refresh token; null when nothing is stored or Auth0 REFUSES the grant (a 4xx carrying an OAuth `error` other than `too_many_requests`, e.g. invalid_grant — that deletes the stored token); REJECTS and keeps the stored token on a transient failure (fetch rejection, timeout, 5xx, 429, or a 2xx whose body is unusable) so an outage never signs the lawyer out
  beginSignIn(): Promise<SignInPrompt>;       // idempotent while a device code is pending; starts the background poll; on success caches the access token and stores refresh_token under account = config.baseUrl; opens the browser when config.openBrowser
  invalidateAccessToken(): void;
  forgetSession(): Promise<void>;
}
// open-browser.ts
export function openBrowser(url: string): void; // spawn("open" | "start" via cmd /c | "xdg-open", detached, stdio ignore, errors swallowed; only https URLs
```

Wire protocol (Auth0): `POST https://{auth0Domain}/oauth/device/code` with `application/x-www-form-urlencoded` body `client_id`, `scope`, `audience` → `DeviceCodeResponse`. `POST https://{auth0Domain}/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `device_code`, `client_id`; a 4xx body `{ error, error_description }`: `authorization_pending` → wait `interval` s and retry; `slow_down` → `interval += 5`; `expired_token`, `access_denied`, anything else → `DeviceFlowError(error)`. Give up when `now() > start + expires_in * 1000` with `DeviceFlowError("expired_token")`. A poll request that fails to connect, times out or answers 5xx is retried after the interval, doubling the interval each time (RFC 8628 §3.5), until the deadline. Refresh: `grant_type=refresh_token`, `client_id`, `refresh_token`; a new `refresh_token` in the response replaces the stored one (rotation). `DeviceFlowError` carries `code` and `status` (the HTTP status, 0 when there was no response) and `name = "DeviceFlowError"`. Every token request is sent with `redirect: "error"` and `signal: AbortSignal.timeout(30_000)`. No token value ever appears in an error message or log line.

- [ ] **Step 1: Write the failing tests** with a fake `fetchImpl` that records requests: device-code request body fields; poll sequence `authorization_pending → slow_down → success` with the recorded sleeps `[5000, 10000]` for `interval: 5`; `access_denied` throws `DeviceFlowError("access_denied")`; expiry; refresh stores the rotated token; `getAccessToken` returns the cached token, refreshes when expired, returns `null` and deletes the stored token when the refresh answers 403 `invalid_grant`; `beginSignIn` twice returns the same prompt while pending; after the background poll succeeds `status()` is `signed_in` and the store holds the refresh token; `openBrowser` is called once with `verification_uri_complete`, not at all when `openBrowser: false`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement the three files.**
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(auth): Auth0 device authorization grant with refresh and a session cache"`

---

### Task 7: REST client and error mapping

**Files:**
- Create: `src/api/errors.ts`, `src/api/client.ts`
- Test: `src/api/client.test.ts`, `src/api/errors.test.ts`

**Interfaces:**
- Produces:

```ts
// errors.ts
export class ApiError extends Error { constructor(public status: number, public code: string, public metadata: Record<string, unknown> = {}) }
export function describeApiError(err: ApiError, baseUrl: string): string;
// client.ts — response types copied from the main repo's lib/api.ts (MatterSummary, Matter, MatterDetail, MatterDocumentSummary, MatterDocumentRecord, MatterDocumentDetail, IngestManifest, ProcessResult, CreateMatterDocumentInput)
export interface CurrentUser { id: number; email: string; plan: string; entitlements: { mattersAccess: boolean; docsPerMatter: number; activeMatters: number; tier: string } }
export interface ApiDeps { baseUrl: string; getToken: () => Promise<string | null>; onUnauthorized: () => Promise<string | null>; fetchImpl: FetchLike }
export class DikigorosApi {
  constructor(deps: ApiDeps);
  currentUser(): Promise<CurrentUser>;                                             // GET  /auth/current-user
  listMatters(): Promise<MatterSummary[]>;                                        // GET  /api/matters → { matters }
  createMatter(input: { title: string; caseReference?: string; matterType?: string; description?: string }): Promise<Matter>;  // POST /api/matters → 201 { matter }
  getMatter(id: number): Promise<MatterDetail>;                                   // GET  /api/matters/{id}
  createDocument(matterId: number, input: CreateMatterDocumentInput): Promise<MatterDocumentRecord>;  // POST /api/matters/{id}/documents → 201 { document }
  patchDocument(matterId: number, docId: number, input: { role?: string; side?: string | null }): Promise<MatterDocumentRecord>; // PATCH …/documents/{docId} → { document }
  createTextDocument(matterId: number, input: { filename: string; text: string }): Promise<MatterDocumentRecord>;  // POST …/documents/text → 201 { document }
  ingest(matterId: number, docId: number, manifest: IngestManifest): Promise<{ ocrPages: number }>;     // POST …/documents/{docId}/ingest
  process(matterId: number, docId: number): Promise<ProcessResult>;                                     // POST …/documents/{docId}/process
  getDocument(matterId: number, docId: number): Promise<MatterDocumentDetail>;                           // GET  …/documents/{docId} → { document }
  requestUploadToken(matterId: number, pathname: string): Promise<string>;                               // POST …/documents/upload with body { "type": "blob.generate-client-token", "payload": { "pathname": pathname, "clientPayload": null, "multipart": false } } → { "type": "blob.generate-client-token", "clientToken": "…" } → the clientToken
}
```

Request rules: headers `Authorization: Bearer ${token}` (throw `ApiError(401, "not_signed_in")` without a token), `Accept: application/json`, `Content-Type: application/json` on bodies. A non-2xx response → `ApiError(status, body.error ?? "http_" + status, body minus error/message)`. Exactly one retry after a 401: call `onUnauthorized()` (the session invalidates and refreshes) and repeat with the token it returns; a second 401 throws. `describeApiError` sentences (English, factual, no plan names beyond the spec's pattern): `entitlement_required` → `"This needs the Firm plan (Matters). Plans: ${baseUrl}/pricing"`; `account_suspended`; `email_not_verified`; `not_signed_in`/401 → `"Sign in again: call the tool once more and follow the sign-in instructions."`; 404 → `"Matter not found (or not yours)."`; `matter_limit_reached` (limit); `document_limit_reached` (limit); `duplicate_document` (documentId); `Weekly usage limit reached` → `"The weekly usage allowance is used up; it resets on Sunday 00:00 UTC."`; `too_many_ocr_pages` (limit 300); `manifest_too_large`; `processing_in_progress`; default → `"${status} ${code}"`.

- [ ] **Step 1: Write the failing tests** — a fake `fetchImpl` asserting method, URL, headers and JSON body per method (including the `requestUploadToken` event body and its unwrapped `clientToken`); 201 bodies unwrapped; a 429 `{ error: "document_limit_reached", limit: 50 }` becomes `ApiError(429, "document_limit_reached", { limit: 50 })`; the 401 retry calls `onUnauthorized` once and re-sends with the new token; two 401s throw; `describeApiError` for each code above.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(api): REST client for the matters routes with a single 401 retry"`

---

### Task 8: Blob upload through the private store

**Files:**
- Create: `src/api/blob-upload.ts`
- Test: `src/api/blob-upload.test.ts`

**Interfaces:**
- Consumes: `DikigorosApi.requestUploadToken` (Task 7).
- Produces:

```ts
export type BlobContentType = "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" | "image/jpeg";
export const BLOB_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
export interface BlobUploadArgs { api: Pick<DikigorosApi, "requestUploadToken">; matterId: number; pathname: string; bytes: Uint8Array; contentType: BlobContentType; timeoutMs?: number }
export async function uploadBlob(args: BlobUploadArgs): Promise<{ url: string }>;
```

Protocol: `uploadBlob` obtains `clientToken = await api.requestUploadToken(matterId, pathname)` (the bearer, the 401 retry and the error mapping are the client's), then calls `put(pathname, new Blob([bytes], { type: contentType }), { access: "private", token: clientToken, contentType })` from `@vercel/blob/client` and returns `{ url }`. The store URL is `process.env.VERCEL_BLOB_API_URL` when set (tests), else the SDK default. The `put` failure (`BlobError`) is re-thrown as `ApiError(502, "blob_upload_failed", { message })` so the pipeline reports it like any other failure. Every `put` carries `abortSignal` from an `AbortController` that a timer aborts after `BLOB_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000` (cleared in `finally`); an abort surfaces as `ApiError(502, "blob_upload_failed", { message: "upload timed out" })`. (The SDK retries only non-abort failures, and `AbortSignal.timeout()`'s TimeoutError would be retried — hence the controller.)

- [ ] **Step 1: Write the failing tests** — an `http.createServer` on `127.0.0.1` that, at `/blob-store/<pathname>`, records the PUT's `authorization`, `x-content-type`, body length and returns `{ url: "https://teststore.private.blob.vercel-storage.com/" + pathname + "-abc123", pathname, contentType, contentDisposition: "" }`; a fake `api` whose `requestUploadToken` records `(matterId, pathname)` and returns `"ct_test"`. Set `process.env.VERCEL_BLOB_API_URL = base + "/blob-store"` before importing the module. Cases: `requestUploadToken` is called with the pathname; the PUT carries `Bearer ct_test`, the content type and the byte length; "keeps a Greek filename with spaces in the pathname" (`matters/u1/m2/Αγωγή αρ. 5.pdf` round-trips, decoded, in the returned URL); a store answering 500 rejects with `ApiError(502, "blob_upload_failed")`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(api): client-token blob upload to the private store"`

---

### Task 9: Native runtime install (pinned, verified, lazy)

**Files:**
- Create: `src/native/platform.ts`, `src/native/install.ts`, `src/native/load.ts`
- Test: `src/native/platform.test.ts`, `src/native/install.test.ts`
- Read: `src/native/lock.generated.json` (exists from Task 1; never regenerate it in this task)

**Interfaces:**
- Produces:

```ts
// platform.ts
export type PlatformKey = "darwin-arm64" | "darwin-x64" | "linux-x64-gnu" | "linux-arm64-gnu" | "win32-x64-msvc" | "win32-arm64-msvc";
export function platformKey(platform: NodeJS.Platform, arch: string): PlatformKey; // throws Error("Unsupported platform: …") for anything else (musl included)
// install.ts
export interface NativeLock { version: number; packages: Record<string, { version: string; tarball: string; integrity: string }>; platforms: Record<string, { canvas: string; keyring: string }> }
export function readNativeLock(json: unknown): NativeLock; // validates the shape (version === 1, every package has version/tarball/sha512 integrity, every platform names known packages) and throws Error("Invalid native lock: …") otherwise — main.ts passes the JSON import through it
export function lockHash(lock: NativeLock): string; // sha256 of JSON.stringify(lock), first 12 hex
export const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000; // per package, an AbortController the fetch carries
export async function ensureNativeRuntime(opts: { dataDir: string; lock: NativeLock; platform: PlatformKey; fetchImpl: FetchLike; log: (line: string) => void }): Promise<{ nodeModulesDir: string; downloaded: boolean }>;
// load.ts
export function loadCanvasModule(nodeModulesDir: string): CanvasModule;     // createRequire(join(dir, "_.cjs"))("@napi-rs/canvas")
export function loadKeyringBinding(nodeModulesDir: string): KeyringBinding; // createRequire(…)("@napi-rs/keyring")
export interface CanvasModule { createCanvas(width: number, height: number): CanvasLike; DOMMatrix: unknown; Path2D: unknown; ImageData: unknown } // the three constructors pdf.js expects as globals in Node
export interface CanvasLike { width: number; height: number; getContext(type: "2d", attrs?: object): CanvasContextLike; encode(format: "jpeg", quality: number): Promise<Buffer> }
export interface CanvasContextLike { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } }
```

`ensureNativeRuntime`: `target = join(dataDir, "native", lockHash(lock))`; when `join(target, ".ok")` exists return `{ nodeModulesDir: join(target, "node_modules"), downloaded: false }`. Otherwise for the four packages `@napi-rs/canvas`, `lock.platforms[platform].canvas`, `@napi-rs/keyring`, `lock.platforms[platform].keyring`: fetch `tarball` (with `signal` from an `AbortController` aborted after `DOWNLOAD_TIMEOUT_MS`; a non-2xx, a rejection or a body-read failure → `Error("Download failed for <name>: <status or the error's first line>", { cause })`), compute `sha512` base64 and compare with `integrity` (`"sha512-" + digest`; mismatch → `Error("Integrity mismatch for <name>")`, nothing extracted), extract with `tar.x({ cwd: join(tmp, "node_modules", name), strip: 1, preserveOwner: false, noMtime: true, onwarn })` from a `Readable.from(buffer)`, where `onwarn(code, message, data)` records the first warning whose code is not `TAR_ENTRY_INFO` (as `data` when it is an Error, else `Error(code + ": " + message)`); on tar's `close`, reject with that recorded error if any — a partially written package never receives `.ok` into `tmp = join(dataDir, "native", ".tmp-" + process.pid + "-" + randomHex)`, write `.ok`, `rename(tmp, target)`; if the rename fails because `target` now exists, remove `tmp` and use `target`. Log one line per package to `log` (name and version only).

- [ ] **Step 1: Write the failing tests** — `platformKey` table (6 keys; `linux` + `x64` with musl detection out of scope → the function takes only platform/arch); `ensureNativeRuntime` against a local http server that serves tarballs built in the test with `tar.c({ gzip: true, cwd }, ["package"])` for four tiny fake packages (each `package/package.json` + `package/index.js` exporting its name) and a lock whose `integrity` is computed from the served bytes: installs into `<dataDir>/native/<hash>/node_modules/@napi-rs/canvas/index.js`, `downloaded: true`; second call `downloaded: false` and no fetch; a tampered tarball → rejects with `Integrity mismatch`, no `node_modules` left behind; a pinned tarball holding an entry that cannot be written (a name longer than 255 bytes) → rejects, nothing left under `native/`, and the next call downloads again; a download from a closed loopback port → rejects with `Download failed for <name>: …` carrying `cause`; `readNativeLock` accepts the committed lock and rejects a lock with `version: 2` or a non-sha512 integrity; `loadCanvasModule` on the installed dir returns the fake module.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(native): install the pinned canvas and keyring packages on first use"`

---

### Task 10: PDF extraction in Node

**Files:**
- Create: `src/extract/pdf.ts`, `test/support/pdf-fixtures.ts`
- Test: `src/extract/pdf.test.ts`

**Interfaces:**
- Consumes: `classifyPage`, `joinPdfTextItems`, `isBlankRaster` (Task 2); `CanvasModule` (Task 9).
- Produces:

```ts
export interface PdfAssets { workerSrc: string /* file:// URL of pdf.worker.min.mjs */; wasmUrl: string /* directory path ending in "/" */; standardFontDataUrl: string /* directory path ending in "/" */ }
export interface ExtractedPdf { pages: { page: number; text: string; needsOcr: boolean }[]; images: Map<number, Uint8Array> }
export function createCanvasFactory(canvas: CanvasModule): new (opts?: { enableHWA?: boolean }) => { create(w: number, h: number): { canvas: CanvasLike; context: CanvasContextLike }; reset(c: { canvas: CanvasLike | null }, w: number, h: number): void; destroy(c: { canvas: CanvasLike | null; context: unknown }): void };
export async function extractPdf(bytes: Uint8Array, opts: { canvas: CanvasModule; assets: PdfAssets; onProgress?: (page: number, total: number) => void }): Promise<ExtractedPdf>;
```

Implementation: pdf.js is imported **dynamically and once** (`const pdfjs = await loadPdfjs(canvas)`, memoised): before the first `import("pdfjs-dist/legacy/build/pdf.mjs")` the loader installs `globalThis.DOMMatrix ??= canvas.DOMMatrix`, `globalThis.Path2D ??= canvas.Path2D`, `globalThis.ImageData ??= canvas.ImageData` — pdf.js polyfills these at import time by requiring `@napi-rs/canvas` next to its own file, which fails inside the bundle (the package lives in the data dir), and a page that draws paths then throws `Path2D is not defined`; after the import it sets `pdfjs.GlobalWorkerOptions.workerSrc = assets.workerSrc`, and every `getDocument` passes `verbosity: pdfjs.VerbosityLevel.ERRORS` (6.4 has no `setVerbosityLevel`; its warnings go through `console.warn`, which main.ts redirects to stderr anyway). Then `getDocument({ data: new Uint8Array(bytes), wasmUrl, standardFontDataUrl, CanvasFactory: createCanvasFactory(opts.canvas) })` (a Node Buffer is refused by pdf.js, hence the copy; `isEvalSupported` does not exist in 6.4). `loadingTask.destroy()` in a `finally`; `page.cleanup()` after each page (a 24-page scan otherwise holds ~50 MB per page). Per page: `getTextContent()` → `joinPdfTextItems(items with "str")` → `classifyPage`; when `needsOcr`: viewport at `scale = 1600 / page.getViewport({ scale: 1 }).width`, a canvas from the factory, `page.render({ canvas, canvasContext, viewport }).promise`, `isBlankRaster(ctx.getImageData(0, 0, w, h).data)`, and when not blank `images.set(n, await canvas.encode("jpeg", 80))`. The factory mirrors pdf.js's `BaseCanvasFactory` (`create` throws on non-positive sizes, `reset` resizes, `destroy` zeroes and nulls). `test/support/pdf-fixtures.ts` writes minimal valid PDFs by hand (objects → byte offsets → xref → trailer): `textPdf(lines: string[])` (one page, Helvetica, ASCII text ≥ 40 letters), `imagePdf({ ink: boolean })` (one page whose content is a 200×200 8-bit DeviceGray uncompressed image XObject, all 0xFF when `ink: false`, with a 100×100 black square when `ink: true`), `blankPdf()` (one page, empty content stream), `twoPagePdf()` (a text page followed by an inked image page).

- [ ] **Step 1: Write the failing tests** (canvas = `createRequire(import.meta.url)("@napi-rs/canvas")`; assets from `node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs`, `node_modules/pdfjs-dist/wasm/`, `node_modules/pdfjs-dist/standard_fonts/`) — a text page needs no OCR and its text contains the fixture sentence; an inked image page needs OCR and yields a JPEG (starts with `0xFF 0xD8`) longer than 2 KB; a blank page needs OCR and yields no image; `onProgress` is called `(1, 2)` then `(2, 2)` for the two-page fixture; `createCanvasFactory(...).create(0, 0)` throws; a page that needs OCR and draws a vector path (fixture `pathPdf()`: one page whose content strokes a thick black line, no text) renders without throwing and yields a JPEG — the `Path2D` case; after `extractPdf` ran, `globalThis.Path2D` and `globalThis.DOMMatrix` are the canvas module's constructors.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(extract): PDF text and page rasterisation in Node with pdf.js and @napi-rs/canvas"`

---

### Task 11: DOCX extraction

**Files:**
- Create: `src/extract/docx.ts`, `test/support/docx-fixture.ts`
- Test: `src/extract/docx.test.ts`

**Interfaces:**
- Produces: `extractDocx(bytes: Uint8Array): Promise<{ fullText: string }>` via `mammoth.extractRawText({ buffer: Buffer.from(bytes) })`; `makeDocx(paragraphs: string[]): Promise<Uint8Array>` (jszip: `[Content_Types].xml`, `_rels/.rels`, `word/document.xml` with one `<w:p>` per paragraph).

- [ ] **Step 1: Write the failing tests** — the two paragraphs come back joined by newlines, Greek intact; a non-zip buffer rejects.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(extract): DOCX text extraction with mammoth"`

---

### Task 12: The document pipeline

**Files:**
- Create: `src/pipeline/upload-document.ts`
- Test: `src/pipeline/upload-document.test.ts`

**Interfaces:**
- Consumes: `PlanEntry` (Task 3), `DikigorosApi`/`ApiError` (Task 7), `uploadBlob` (Task 8), `extractPdf` (Task 10), `extractDocx` (Task 11), `decodeTextBytes`/`normalizeTextDocument`/`headBytesBase64`/`MAX_TEXT_DOCUMENT_CHARS` (Task 2).
- Produces:

```ts
export const POLL_INTERVAL_MS = 1500;
export const DEFAULT_MAX_WAIT_MS = 10 * 60 * 1000;
export interface UploadContext { baseUrl: string; userId: number; matterId: number; role?: string; side?: string }
export interface UploadDeps { api: DikigorosApi; uploadBlob: typeof uploadBlob; extractPdf: (bytes: Uint8Array, onProgress?: (p: number, t: number) => void) => Promise<ExtractedPdf>; extractDocx: typeof extractDocx; readFile: (path: string) => Promise<Uint8Array>; sleep: (ms: number) => Promise<void>; now: () => number; pollIntervalMs?: number; maxWaitMs?: number; log: (line: string) => void }
export type OutcomeStatus = "ready" | "processing" | "failed" | "duplicate" | "skipped";
export interface DocumentOutcome { name: string; status: OutcomeStatus; documentId?: number; pageCount?: number; ocrPages?: number; ocrRemaining?: number; code?: string; message?: string; roleApplied?: boolean }
export async function uploadDocument(entry: PlanEntry, ctx: UploadContext, deps: UploadDeps): Promise<DocumentOutcome>;
export function matterBlobPrefix(userId: number, matterId: number): string; // `matters/u${userId}/m${matterId}/` (ported from lib/matters.ts)
```

Flow for `pdf`/`docx` (the browser hook's order): bytes → `sha256` hex → `uploadBlob({ api: deps.api, matterId, pathname: prefix + entry.name, bytes, contentType })` → extract (`docx` → `{ kind: "docx", fullText }`; `pdf` → pages; when every page needs OCR and no image rendered → outcome `failed`, code `no_text_extracted`, no `createDocument`) → for each OCR page with an image `uploadBlob({ pathname: `${prefix}pages/p${n}.jpg`, contentType: "image/jpeg" })` and `imageBlobKey = url` → `createDocument({ filename: entry.name, mimeType, sizeBytes, sha256, blobUrl, headBytesBase64 })` (`mimeType` `application/pdf` or the DOCX type) → on `ApiError` `duplicate_document`: `getDocument(documentId)`; `processing`/`failed` → resume the poll on it (outcome `ready`/`processing`); `pending` (a previous run died between create and ingest) → `ingest` the manifest just built into that twin, then poll; `ready` → outcome `duplicate` → when `ctx.role` or `ctx.side` is set `patchDocument` (an `ApiError` 401/403 here sets `roleApplied: false`, logs one line, and the upload continues; other errors propagate) → `ingest(manifest)` → `{ ocrPages }` → poll `process()` every `pollIntervalMs`: `status "ready"` → outcome `ready` with `pageCount`, `ocrPages`; `"failed"` → `failed` with `errorCode ?? "processing_failed"`; `processing` → `deps.log(\`<name>: OCR, <ocrRemaining> page(s) remaining\`)` only when `ocrRemaining` changed since the last log line (`finalizing` when it is 0), and continue (a 409 `processing_in_progress` also continues); past `maxWaitMs` → outcome `processing` with `ocrRemaining` and message "still processing; the matter page resumes it, or call again later". Flow for `text`: `decodeTextBytes` null → `skipped` `text_encoding`; `normalizeTextDocument` empty → `skipped` `text_empty`; over `MAX_TEXT_DOCUMENT_CHARS` → `skipped` `text_too_long`; `createTextDocument({ filename, text })` (409 duplicate handled as above) → patch role/side → poll. Once polling has started, a transient failure of `process` (a non-`ApiError` rejection, or an `ApiError` with status 5xx or 429) is retried after the interval until `maxWaitMs`, and if it never recovers the outcome is `processing` (the row is still resumable) with the still-processing message plus the last error's first line — never `failed`. A `getDocument` of a twin that is refused (401, 403, 404) → outcome `duplicate` with the twin's id. A local read failure → `failed`, code `unreadable`; an extractor rejection (corrupt PDF, a zip that is not a DOCX) → `failed`, code `extraction_failed`, the error's first line as the message. Any other `ApiError` → outcome `failed` with `code = err.code` and `message = describeApiError(err, ctx.baseUrl)`; a 401 after the client's retry (the token was refreshed and the route still refused it — the route is not on the connector-token allowlist, or the session is dead) → code `unauthorized` and the message "The server refused the helper's sign-in for <METHOD path>; this route may not accept helper tokens yet (docs/assumed-routes.md)". A non-`ApiError` rejection outside the read/extract/poll cases above (a network failure, a keychain read failure surfaced through `getToken`) → outcome `failed` with code `network` and the error's first line as the message. A twin resumed with `ctx.role`/`ctx.side` set is not patched and reports `roleApplied: false`.

- [ ] **Step 1: Write the failing tests** with a recording fake `api` (every method a `vi.fn()` with canned answers), a fake `uploadBlob` returning `https://teststore.private.blob.vercel-storage.com/<pathname>-x`, fake extractors and `readFile`: the PDF happy path records the call order `uploadBlob(main) → extractPdf → uploadBlob(pages/p2.jpg) → createDocument → ingest → process…` and the `createDocument` body; `headBytesBase64` is the first 8 bytes; a DOCX manifest is `{ kind: "docx", fullText }`; `no_text_extracted` makes no `createDocument` call; `duplicate_document` on a `ready` twin → `duplicate` with its id, on a `processing` twin → resumes polling to `ready`; role/side are patched before `ingest` and a 401 on the patch leaves `roleApplied: false`; `maxWaitMs` → `processing` with `ocrRemaining`; text file windows-1253 is decoded and posted normalised; undecodable → `skipped text_encoding`; a 429 `document_limit_reached` → `failed` with that code and a message naming the limit.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(pipeline): upload one document the way the web uploader does"`

---

### Task 13: The MCP tools and server wiring

**Files:**
- Create: `src/server/tools.ts`, `src/server/assets.ts`, `src/server/main.ts`
- Test: `src/server/tools.test.ts`, `src/server/assets.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:

```ts
// tools.ts
export const MATTER_TYPES = ["civil", "criminal", "interim_application", "appeal", "other"] as const;
export const MATTER_UPLOAD_ROLES = ["statement_of_claim", "defense", "reply", "affidavit", "opposition", "witness_statement", "exhibit", "interim_application", "court_order", "correspondence", "other", "written_submission", "judgment", "expert_report", "minutes", "notice", "bundle"] as const; // lib/matters.ts MATTER_UPLOAD_ROLES @ 37f39ac5
export const MATTER_SIDES = ["ours", "theirs", "neutral"] as const;
export type SessionLike = Pick<AuthSession, "status" | "getAccessToken" | "beginSignIn" | "forgetSession">;
export interface ToolDeps { config: HelperConfig; session: SessionLike; api: DikigorosApi; resolvePlan: typeof resolveUploadPlan; upload: (entry: PlanEntry, ctx: UploadContext) => Promise<DocumentOutcome>; tokenStoreWarning: () => Promise<string | null> }
export function registerTools(server: McpServer, deps: ToolDeps): void;
export async function handleUploadToMatter(args: UploadToMatterArgs, deps: ToolDeps): Promise<CallToolResult>;  // exported for tests
export async function handleCreateMatter(args: CreateMatterArgs, deps: ToolDeps): Promise<CallToolResult>;
// assets.ts
export function resolveAssets(bundleUrl: string): PdfAssets; // dirname(fileURLToPath(bundleUrl)) → pdf.worker.min.mjs (file URL), wasm/ and standard_fonts/ as directory paths ending in "/" with forward slashes
```

Tool `upload_to_matter` — `title: "Upload files to a matter"`, `inputSchema: z.object({ matter_id: z.number().int().positive(), paths: z.array(z.string().min(1).max(1024)).min(1).max(MAX_PATHS_PER_CALL), role: z.enum(MATTER_UPLOAD_ROLES).optional(), side: z.enum(MATTER_SIDES).optional(), confirm: z.boolean().optional(), plan_digest: z.string().optional() })`, `annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }`, description: "Use this when the lawyer asks to add files from this computer to a DIKIGOROS matter. Takes absolute paths to .pdf, .docx, .txt or .md files, or to a folder (its top-level files). The first call lists what would be uploaded and uploads nothing; call again with confirm: true to upload. Not for files already in the matter, other file types, or for searching or reading matter documents." Handler order: (1) `config.auth0ClientId === ""` → `isError` "The helper is not configured (DIKIGOROS_AUTH0_CLIENT_ID is empty)."; (2) `session.getAccessToken()` REJECTS (the sign-in service could not be reached, or the keychain could not be read) → `isError` "Could not reach the sign-in service (<first line of the error>). Nothing was changed; try again in a moment." — never a new sign-in; `session.getAccessToken()` null → `beginSignIn()` and return (not an error) `"Sign in to DIKIGOROS first: open <verificationUriComplete> and enter code <userCode> (valid <n> minutes). Then call this tool again."` with `structuredContent { status: "sign_in_required", verification_uri_complete, user_code, expires_in_seconds }`; (3) `resolvePlan(paths)`; without `confirm: true` → text table (name · size · type · upload/skip(reason)) followed by `"Nothing has been uploaded. Call again with confirm: true and plan_digest \"<digest>\" to upload the <n> file(s) marked upload."`, `structuredContent { status: "confirmation_required", plan_digest, files }`; (4) with `confirm: true`: a `plan_digest` that does not match the fresh digest → return the fresh plan with `status: "plan_changed"` (nothing uploaded); no upload entries → `"Nothing to upload."`; (5) `api.currentUser()` — an `ApiError` 401 here means the refreshed token is refused by an allowlisted route, i.e. the session is dead: call `session.forgetSession()`, then `beginSignIn()` and return the sign-in instructions as in (2); `entitlements.mattersAccess` false → `isError` with the plan sentence; `api.getMatter(matter_id)`; `docsPerMatter !== -1 && documents.length + uploads.length > docsPerMatter` → `isError` "Matter #<id> holds <x> of <limit> documents; <n> more would exceed the limit. Nothing was uploaded."; (6) upload sequentially via `deps.upload` with `UploadContext { baseUrl, userId: me.id, matterId, role, side }`; (7) result text: one line per file `"<name>: <status>[ — <message>]"` plus the matter URL `${baseUrl}/matters/${id}`, `structuredContent { status: "done", matter_id, matter_url, results }`; the keychain warning, when any, is appended once. Any `ApiError` escaping the handler → `isError` with `describeApiError`; an `ApiError` 401 (other than `not_signed_in`) from `create_matter` is handled like step (5): `forgetSession()`, `beginSignIn()`, the sign-in text. A non-`ApiError` rejection after the sign-in gate (offline, DNS, an Auth0 outage inside `onUnauthorized`) → `isError` with, for `upload_to_matter`, "Could not reach DIKIGOROS (<first line>). Nothing was uploaded; try again in a moment." and, for `create_matter`, "Could not reach DIKIGOROS (<first line>). The matter may not have been created; check <baseUrl>/matters before trying again." — never the SDK's raw error. The listing's `structuredContent` also carries `empty_paths`. `ToolDeps` carries `nativeRuntime: () => Promise<unknown>` (the lazy install the handler resolves before PDF uploads).

Tool `create_matter` — `title: "Create a matter"`, `inputSchema: z.object({ title: z.string().trim().min(1).max(300), type: z.enum(MATTER_TYPES).optional(), case_reference: z.string().max(300).optional(), description: z.string().max(2000).optional() })`, annotations as above, description: "Use this when the lawyer asks to open a new matter in DIKIGOROS, for example before uploading files to it. Creates the matter with a title and optional type, case reference and description. Not for changing, archiving or deleting an existing matter." Steps (1)–(2) as above, then `api.createMatter({ title, matterType: type, caseReference: case_reference, description })` → `"Created matter #<id> \"<title>\" — <baseUrl>/matters/<id>"`, `structuredContent { matter: { id, title, matter_type, case_reference, status, url } }`.

`main.ts`: first of all, redirect `console.log`, `console.info`, `console.warn`, `console.debug` and `console.dir` to `console.error` (stdout is the JSON-RPC channel; a library's stray print must never reach it); then `loadConfig(process.env, os.homedir())` (a `ConfigError` → `console.error(message)`, `process.exit(1)`); a maintenance mode for CI and the smoke test, `node dikigoros-upload.mjs --extract-check <file>`: loads the native runtime (honouring `DIKIGOROS_HELPER_NATIVE_DIR`), runs `extractPdf` on the file with the bundle's assets, prints exactly one JSON line `{"pages":<n>,"needsOcr":<n>,"images":<n>}` to stdout and exits 0 (any failure: the message to stderr, exit 2) — no MCP server is started in that mode; `assets = resolveAssets(import.meta.url)`; a lazy `runtime = once(() => ensureNativeRuntime({ dataDir: config.dataDir, lock, platform: platformKey(process.platform, process.arch), fetchImpl: fetch, log }))` honouring `config.nativeDirOverride` (use it as `nodeModulesDir`, no download) — `once` (in `src/server/lazy.ts`, unit-tested) memoises a fulfilled promise only: a rejection is forgotten so the next tool call retries the install after a network blip; `store = once(() => createTokenStore(async () => loadKeyringBinding((await runtime()).nodeModulesDir)))`; `session = new AuthSession({ config, store: () => store().then(s => s.store), fetchImpl: fetch, sleep, now: Date.now, openBrowser: config.openBrowser ? openBrowser : () => {}, log })`; `api = new DikigorosApi({ baseUrl, getToken: () => session.getAccessToken(), onUnauthorized: async () => { session.invalidateAccessToken(); return session.getAccessToken(); }, fetchImpl: fetch })`; `upload` builds `UploadDeps` with `extractPdf` bound to `loadCanvasModule((await runtime()).nodeModulesDir)` and `assets`; before uploading, the handler resolves `runtime()` once when the plan holds any `pdf` entry: a native-install failure (download, integrity, unsupported platform) marks every `pdf` entry's outcome `failed` with code `native_runtime_unavailable` and the error's first line as the message, and the DOCX and text entries still upload (the pipeline itself maps unknown rejections to `network`, so the check lives here); `serveStdio(() => { const server = new McpServer({ name: "dikigoros-upload", version: PLUGIN_VERSION }); registerTools(server, deps); return server; })`. `log = (line) => console.error("[dikigoros-upload] " + line)`. At startup `process.env.VERCEL_BLOB_RETRIES ||= "2"` (`||=`, so an empty value is covered too) (the blob SDK's default of 10 retries with doubling backoff would hide a dead store for half an hour). `PLUGIN_VERSION` is an esbuild `define` (Task 14): declare it in `src/server/main.ts` as `declare const PLUGIN_VERSION: string | undefined;` and read `typeof PLUGIN_VERSION === "string" ? PLUGIN_VERSION : "dev"`. The lock is imported as `import lock from "../native/lock.generated.json" with { type: "json" }`. `FetchLike` (`typeof fetch`) is exported by `src/auth/device-flow.ts` (Task 6) and imported from there by Tasks 7, 8, 9 and 12.

- [ ] **Step 1: Write the failing tests** (`handleUploadToMatter`/`handleCreateMatter` with fake deps): unconfigured client id → `isError`; signed out → `sign_in_required` with the prompt, `beginSignIn` called once; no confirm → `confirmation_required`, `upload` never called, the text names every file and its decision; confirm with a stale digest → `plan_changed`, nothing uploaded; confirm → `currentUser`, `getMatter`, then one `upload` per planned file in order, text lines per outcome, `structuredContent.results`; `docsPerMatter` exceeded → `isError`, no uploads; `mattersAccess: false` → the plan sentence; `create_matter` maps `type`→`matterType`, `case_reference`→`caseReference`; no result text ever contains the access token (assert on a token value `"tok_secret"` returned by the fake session); `resolveAssets("file:///x/server/dikigoros-upload.mjs")` → `{ workerSrc: "file:///x/server/pdf.worker.min.mjs", wasmUrl: "/x/server/wasm/", standardFontDataUrl: "/x/server/standard_fonts/" }`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement the three files.**
- [ ] **Step 4: Run to verify pass**, then `npm run typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "feat(server): upload_to_matter and create_matter tools over stdio"`

---

### Task 14: Build, plugin manifest, marketplace, smoke test

**Files:**
- Create: `scripts/build.ts`, `plugins/dikigoros/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `plugins/dikigoros/README.md` (three lines pointing at the root README)
- Generated and committed: `plugins/dikigoros/server/dikigoros-upload.mjs`, `…/dikigoros-upload.mjs.LEGAL.txt`, `…/pdf.worker.min.mjs`, `…/wasm/*`, `…/standard_fonts/*`
- Test: `test/plugin-manifest.test.ts`, `test/plugin-smoke.test.ts`

**Interfaces:**
- Produces: `npm run build` (idempotent: a second run changes no file); `PLUGIN_VERSION` read by the bundle from `plugins/dikigoros/.claude-plugin/plugin.json` at build time via esbuild `define`.

`scripts/build.ts`: `esbuild.build({ entryPoints: ["src/server/main.ts"], bundle: true, platform: "node", format: "esm", target: "node22", outfile: "plugins/dikigoros/server/dikigoros-upload.mjs", minify: true, legalComments: "external", external: ["@napi-rs/canvas", "@napi-rs/keyring"], define: { "process.env.NODE_ENV": "\"production\"", PLUGIN_VERSION: JSON.stringify(version) }, banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" }, logLevel: "info" })` then copies `node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs`, `node_modules/pdfjs-dist/wasm/{jbig2.wasm,openjpeg.wasm,qcms_bg.wasm,LICENSE_*}`, and `node_modules/pdfjs-dist/standard_fonts/*` into `plugins/dikigoros/server/`. pdf.js's `import(workerSrc)` stays dynamic (esbuild warns, that is expected). Everything else is bundled — `undici`, if `@vercel/blob/client` pulls it in, stays inside the bundle, never external. The two `external` packages are loaded at runtime from the installed native directory (Task 9), never from the bundle's own location.

`plugin.json`:

```json
{
  "name": "dikigoros",
  "displayName": "DIKIGOROS AI",
  "version": "0.1.0",
  "description": "Cyprus case law, legislation and matters from DIKIGOROS AI, plus a local helper that uploads files from this computer into a matter.",
  "author": { "name": "DIKIGOROS AI", "url": "https://dikigoros.ai" },
  "homepage": "https://dikigoros.ai/connect",
  "repository": "https://github.com/dikigoros-ai/claude-plugins",
  "license": "MIT",
  "keywords": ["cyprus", "law", "legal-research", "matters"],
  "mcpServers": {
    "dikigoros": { "type": "http", "url": "https://dikigoros.ai/mcp" },
    "dikigoros-upload": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/server/dikigoros-upload.mjs"],
      "env": { "DIKIGOROS_AUTH0_DOMAIN": "dikigoros-prod.eu.auth0.com", "DIKIGOROS_AUTH0_CLIENT_ID": "" }
    }
  }
}
```

`marketplace.json`: `{ "name": "dikigoros-ai", "description": "DIKIGOROS AI plugins for Claude", "owner": { "name": "DIKIGOROS AI", "url": "https://dikigoros.ai" }, "metadata": { "version": "0.1.0" }, "plugins": [ { "name": "dikigoros", "source": "./plugins/dikigoros", "description": "<same as plugin.json>", "version": "0.1.0", "category": "legal", "tags": ["cyprus", "law", "matters"] } ] }`.

- [ ] **Step 1: Write the failing tests** — `plugin-manifest.test.ts`: both JSON files parse; entry name equals manifest name; `source` directory exists; versions equal across `plugin.json`, the entry and `package.json`; the plugin root has no `bin/`; `mcpServers.dikigoros.url === "https://dikigoros.ai/mcp"`; the stdio `args[0]` names an existing file after replacing `${CLAUDE_PLUGIN_ROOT}`; no `userConfig`. `plugin-smoke.test.ts`: spawn `process.execPath` on the bundle with env `DIKIGOROS_BASE_URL=http://localhost:3000`, `DIKIGOROS_AUTH0_CLIENT_ID=test`, `CLAUDE_PLUGIN_DATA=<tmp>`; write the JSON-RPC lines `initialize` (`protocolVersion "2025-11-25"`, `capabilities {}`, `clientInfo { name: "smoke", version: "0" }`), `notifications/initialized`, `tools/list`; expect the `tools/list` result to hold exactly `upload_to_matter` and `create_matter`, each with `title`, `annotations.destructiveHint === false` and an `inputSchema`; stdout holds only JSON lines; a second spawn with `DIKIGOROS_BASE_URL=https://example.com` exits 1 with a stderr line naming the allowed origins; the extract-check spawns run the bundle from a COPY of `plugins/dikigoros` in a temp directory outside the repository (so no `node_modules` sits above it and pdf.js cannot find `@napi-rs/canvas` by itself), with `DIKIGOROS_HELPER_NATIVE_DIR=<repo>/node_modules` (the dev dependencies hold `@napi-rs/canvas` and its platform package, so CI downloads nothing): `--extract-check <twoPagePdf fixture written to a temp file>` prints exactly one stdout line `{"pages":2,"needsOcr":1,"images":1}` and exits 0, and `--extract-check <pathPdf fixture>` prints `{"pages":1,"needsOcr":1,"images":1}` — the bundle-level proof that the worker, the standard fonts, the canvas globals (`Path2D`) and the factory work outside node_modules (the wasm decoders are not exercised: no fixture is CCITT/JBIG2-encoded; recorded as a follow-up).
- [ ] **Step 2: Run to verify failure** — `npx vitest run test/plugin-manifest.test.ts test/plugin-smoke.test.ts` → FAIL (no bundle, no manifests).
- [ ] **Step 3: Write `scripts/build.ts` and the manifests; run `npm run build`**, then run `npm run build` again and `git status --short plugins/` must show the same files (deterministic output).
- [ ] **Step 4: Run to verify pass**, plus `claude plugin validate ./plugins/dikigoros` and `claude plugin validate .` → `Validation passed` (the controller runs these two if the CLI is absent in the implementer's environment).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(plugin): marketplace, manifest and the bundled dikigoros-upload server"`

---

### Task 15: Integration test against the fake API

**Files:**
- Create: `test/support/fake-api.ts`, `test/integration/upload-flow.test.ts`

**Interfaces:**
- Produces: `startFakeApi(opts?: { docsPerMatter?: number; ocrBatches?: number }): Promise<{ baseUrl: string; requests: RecordedRequest[]; state: { matters: Map<number, …>; documents: Map<number, …>; blobs: Map<string, number /* bytes */> }; close(): Promise<void> }>` — an `http` server implementing `GET /auth/current-user`, `GET|POST /api/matters`, `GET /api/matters/:id`, `POST …/documents`, `POST …/documents/upload` (client-token event → `{ type: "blob.generate-client-token", clientToken: "vercel_blob_client_teststore_<rand>" }` — the SDK refuses a token without the `vercel_blob_client_` prefix), `PATCH|GET …/documents/:docId`, `POST …/documents/text`, `POST …/ingest`, `POST …/process` (first `ocrBatches` polls answer `{ status: "processing", ocrRemaining: n }`, then `{ status: "ready", ocrRemaining: 0, document }`), and the store: `PUT /blob-store/?pathname=<encoded>` (the SDK 2.8.2 sends the pathname as a query parameter, with `authorization: Bearer <clientToken>`, `x-api-version`, `x-content-type`; the handler consumes the body, records its size under the decoded pathname, and returns `{ url: "https://teststore.private.blob.vercel-storage.com/<pathname>-<rand>", pathname, contentType, contentDisposition: "" }`). The test sets `process.env.VERCEL_BLOB_RETRIES = "0"` and `VERCEL_BLOB_API_URL = base + "/blob-store"` before each run (both are read per request). Every route requires `Authorization: Bearer <the token the test configured>`; a wrong or missing bearer answers 401 `{ error: "Authentication required" }`. The documents route sniffs `headBytesBase64`, enforces `docsPerMatter`, dedupes on `(matterId, sha256)` with 409 `duplicate_document`.

- [ ] **Step 1: Write the failing test** — a temp folder with `claim.pdf` (text fixture), `scan.pdf` (inked image fixture), `brief.docx` (jszip fixture), `notes.txt` (UTF-8 Greek), `.hidden.pdf`, `photo.jpg`; `VERCEL_BLOB_API_URL` pointed at the fake store; real `DikigorosApi` (with `getToken: async () => "test-token"` and `onUnauthorized` returning the same), real `uploadBlob`, `extractPdf` (dev `@napi-rs/canvas`), `extractDocx`, and a stub `SessionLike` (`status: () => "signed_in"`, `getAccessToken: async () => "test-token"`, `beginSignIn` and `forgetSession` that throw if called), `nativeRuntime: async () => ({ nodeModulesDir: <repo>/node_modules })`; `handleUploadToMatter` without confirm → 4 upload entries and 2 skips; with confirm → 4 outcomes `ready`; assertions on the recorded requests: every API request carries the bearer; the blob token route received the `blob.generate-client-token` event; `scan.pdf` produced one `pages/p1.jpg` PUT larger than 2 KB and a manifest with `needsOcr: true` and an `imageBlobKey` under the matter prefix; `claim.pdf`'s manifest page has `needsOcr: false` and the fixture text; `brief.docx` sent `{ kind: "docx", fullText }`; `notes.txt` went to `/documents/text` with normalised text; `createDocument` bodies carry `sha256` (64 hex) and `sizeBytes` equal to the files; a second confirmed call reports all four as `duplicate`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement the fake API and make the test pass.**
- [ ] **Step 4: Run the whole suite** — `npm run check` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "test: whole upload flow against a fake DIKIGOROS API and blob store"`

---

### Task 16: Documentation

**Files:**
- Create: `README.md`, `docs/assumed-routes.md`, `docs/release-process.md`, `CHANGELOG.md`

- [ ] **Step 1: Write `README.md`** — sections: What this is (the plugin: remote connector + local helper); Install (`/plugin marketplace add dikigoros-ai/claude-plugins`, `/plugin install dikigoros`; Node ≥ 22.13 on PATH for Cowork and Claude Code; web Claude ignores the local server); What the helper does (the two tools, the confirm step with an example first and second call, roles/sides); What leaves this machine and when (table: Auth0 sign-in requests to the tenant at sign-in and refresh; file bytes and page images (JPEG of scanned pages) to the DIKIGOROS private blob store (EU) and the extracted text manifest to dikigoros.ai only after `confirm: true`; the pinned native packages downloaded from registry.npmjs.org on first use, verified against the committed lock; nothing else); Where the sign-in is kept (OS keychain entry `dikigoros-upload-helper`; how to remove it); Configuration (the env table from Task 4); Limits (accept list, 50 MB, documents per matter, 100 files per call); Troubleshooting (`node` not found in Cowork; unsupported platform; keychain unavailable; "helper not configured"); Development (`npm run check`, `npm run build`, `claude plugin validate`).
- [ ] **Step 2: Write `docs/assumed-routes.md`** — one row per REST route the helper calls (method, path, scope it needs on the connector-token allowlist, request body fields, success shape, the error codes handled) copied from the client of Task 7 and the fake API of Task 15, with a bold note that two routes are **not** in PR 1's `CONNECTOR_TOKEN_ROUTES` and must be added by the main series' PR 4: `POST /api/matters/[id]/documents/text` (`matters:write`) and `PATCH /api/matters/[id]/documents/[docId]` (`matters:write`, role/side only). Include the blob-token event body, the manifest shapes, and the Auth0 endpoints and parameters the device flow uses.
- [ ] **Step 3: Write `docs/release-process.md`** — bump the three versions; `npm run pin-native` only when a native version changes; `npm run build`; `npm run check`; commit the `plugins/` output; tag `v<version>`; CI's `git diff --exit-code -- plugins/` is the guard; the marketplace entry version is what tells installed clients to update.
- [ ] **Step 4: Write `CHANGELOG.md`** — `0.1.0`: initial release.
- [ ] **Step 5: Commit** — `git commit -m "docs: README, assumed routes, release process"`

---

## Appendix A — spec excerpts the tasks argue from

**§5.6 The local helper** (verbatim): see the Global Constraints; the source text is reproduced here for executors without the main repo.

> MCP has no file channel … The helper ships inside a Claude plugin: Repository `dikigoros-ai/claude-plugins` (public; it contains no know-how), marketplace `.claude-plugin/marketplace.json`, one plugin `dikigoros`: `plugin.json` with `mcpServers` listing the remote connector (`https://dikigoros.ai/mcp`) **and** the local stdio server `dikigoros-upload` (Node, bundled, no top-level `bin/`, which would make claude.ai and Cowork refuse the plugin). Install: `/plugin marketplace add dikigoros-ai/claude-plugins` then `/plugin install dikigoros`. Cowork runs the local server when the session is on the user's machine; Claude Code runs it always; web Claude lists the remote connector and ignores the local one.
> Tools: `upload_to_matter(matter_id, paths[], role?, side?)` and `create_matter(...)`. The helper echoes the resolved file list (name, size, type) in its result and uploads only on `confirm: true` in a second call … It skips dotfiles and anything outside `MATTER_UPLOAD_ACCEPT` (`.pdf,.docx,.txt,.md`), enforces `MAX_FILE_BYTES` (50 MB) and the matter's `docsPerMatter`, and refuses paths containing symlink traversal out of the named directory.
> Auth: Auth0 **device authorization grant** (the helper prints/opens a URL and a code once; the browser completes sign-in and consent); refresh token in the OS keychain (`keytar`-class store), never on disk in plaintext; the token is the same audience as the connector, so every REST route accepts it (§4.2).
> Pipeline: it does what `use-document-upload.ts` does in the browser, in Node: SHA-256; `POST /api/matters/[id]/documents/upload` for the blob token and the client upload to the private store under the matter prefix; `POST …/documents` with `blobUrl`, `sha256`, `sizeBytes`, head bytes; extraction and rasterization locally (`mammoth` for DOCX; `pdfjs-dist` with `@napi-rs/canvas` for PDF text and page images, the same `classifyPage` / `isBlankRaster` logic lifted from `lib/matter-extract.ts` into an environment-neutral module shared by both); `POST …/ingest` with the manifest; poll `POST …/process` until `ready`, reporting OCR progress. The server side is untouched …
> Updates: the plugin pins a version; the marketplace entry is bumped with the repo release. The helper refuses to run against anything but `https://dikigoros.ai` and `http://localhost:3000` (dev).

**§4.2 allowlist as PR 1 implements it** (`lib/mcp/auth.ts` `CONNECTOR_TOKEN_ROUTES` on `feat/mcp-connector-01-foundation`): `GET /api/matters` (matters:read), `POST /api/matters` (matters:write), `GET /api/matters/\d+` (matters:read), `GET …/documents` (matters:read), `POST …/documents` (matters:write), `POST …/documents/upload` (matters:write), `GET …/documents/\d+` (matters:read), `POST …/documents/\d+/ingest` (matters:write), `POST …/documents/\d+/process` (matters:write), `GET /api/usage` (account:read), `GET /auth/current-user` (account:read). Missing for this helper: `POST …/documents/text` and `PATCH …/documents/\d+` (recorded in `docs/assumed-routes.md`, Task 16).

## Appendix B — rulings taken while planning (the controller's, each reversible)

1. Native binaries are not committed; the bundle installs the pinned npm tarballs on first use (sizes above). Override with `DIKIGOROS_HELPER_NATIVE_DIR` for an offline machine.
2. `@modelcontextprotocol/server` v2 (`serveStdio`), zod 4 — the same SDK line PR 1's `mcp-handler` 2.x wraps.
3. `.txt`/`.md` go through `POST …/documents/text` like the browser (the documents route sniffs PDF/DOCX only) — an allowlist addition for PR 4.
4. `role`/`side` are applied with `PATCH …/documents/[docId]` right after the row is created (so the classifier never overrides the lawyer's choice); a refusal is reported, not fatal — an allowlist addition for PR 4.
5. `create_matter` takes `title`, `type`, `case_reference`, `description`; the route has no `parties` field, so none is offered.
6. The confirm step carries an optional `plan_digest`; a changed folder between the two calls is refused and re-listed.
7. Sign-in is implicit: the first tool call without a session starts the device flow and returns the URL and code; the poll runs inside the server process.
8. Without a keychain the session lives in memory for the process only, with a warning in the result.
9. Directories are listed one level deep; 50 paths and 100 files per call.
10. A duplicate whose twin is still `processing` is resumed (polled to `ready`) instead of reported as a duplicate.
