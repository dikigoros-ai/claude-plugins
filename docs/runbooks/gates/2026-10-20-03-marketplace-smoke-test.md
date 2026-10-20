# Gate 03 — the live pass of the plugin on Nicolas's machine (Cowork + Claude Code)

**Operators:** Nicolas (runs it), Mike (prerequisites) · **Where:** Nicolas's Mac, a real folder of case documents · **Date opened:** 2026-10-20 · **Opened by:** the PR 5 session.

## What it blocks

- Calling PR 5 verified end to end (spec §9, row 5: "Cowork and Claude Code live pass … with a real folder (PDF scan, DOCX, TXT); the CCITT-G4 fixture"). The repository's own tests run the whole pipeline against a recorded fake of the routes; this gate is the first time real bytes reach dikigoros.ai through the helper.
- Announcing the plugin to lawyers and the directory listing.

## Prerequisites (Mike)

| # | What | Why |
|---|---|---|
| 1 | Gate 01 done on the tenant the server uses | the helper's sign-in |
| 2 | The main app's **PR 1** (`feat/mcp-connector-01-foundation`) **and PR 4** (Matters tools) deployed to the environment you test against, with `MCP_ENABLED=true` | PR 1 makes the REST routes accept connector tokens on a deny-by-default allowlist; PR 4 must add the two routes the helper also needs — `POST /api/matters/[id]/documents/text` and `PATCH /api/matters/[id]/documents/[docId]` (role/side) — see `docs/assumed-routes.md` in this repository. Without PR 4, `.txt`/`.md` files and `role`/`side` are refused with *"The server refused the helper's sign-in for …"*, PDFs and DOCX still work |
| 3 | A **Firm** test account on that environment (Matters needs `mattersAccess`) | the plan gate |
| 4 | On Nicolas's Mac: Node.js **22.13 or later** on the `PATH` (`node --version`), Claude Code, and Cowork | the helper is a Node process the clients start |

Two ways to run it, pick one:

- **Against the local dev server** (staging tenant, the usual test surface): `npm run dev` of the main app with PR 1 + PR 4 checked out, `.env.local` per PR 1's runbook (`AUTH0_MCP_AUDIENCE=http://localhost:3000/mcp`), and the helper told to use it (step 2 below).
- **Against production** (only once PR 1 + PR 4 are live and gate 01 is done on `dikigoros-prod`): nothing to set; the plugin's defaults point at `https://dikigoros.ai`.

## Steps

### 1. Install the plugin (Claude Code first)

In a terminal:

```bash
claude plugin marketplace add dikigoros-ai/claude-plugins
claude plugin install dikigoros@dikigoros-ai
claude plugin list
```

Expected: `dikigoros@dikigoros-ai` listed with `Status: ✔ enabled`. (Members of the organisation can do this while the repository is private, with `gh auth login` done once; lawyers need gate 02.)

### 2. Point the helper at the test environment (local dev server only)

The helper reads its environment from the shell that starts Claude Code; the manifest fixes only the Auth0 domain. Start Claude Code from a shell where these are exported:

| Variable | Value |
|---|---|
| `DIKIGOROS_BASE_URL` | `http://localhost:3000` (the only other origin the helper accepts) |
| `DIKIGOROS_AUTH0_DOMAIN` | `dikigoros-staging.eu.auth0.com` |
| `DIKIGOROS_AUTH0_CLIENT_ID` | the staging application's Client ID from gate 01 |

If the manifest already carries a production client id, the manifest's value wins for `DIKIGOROS_AUTH0_CLIENT_ID`; in that case install from a local checkout instead: `git clone`, edit `plugins/dikigoros/.claude-plugin/plugin.json`'s `env`, and start `claude --plugin-dir ./plugins/dikigoros`.

### 3. The folder

A real matter folder, or a scratch one holding:

| File | Source | What it exercises |
|---|---|---|
| `scan.pdf` | the main repository's `e2e/fixtures/ccitt-g4-scan.pdf` (one black-and-white fax-encoded page, no text layer) | the wasm decoders + rasterisation + the server's OCR — the case the web uploader got wrong once |
| any text PDF | a judgment or a pleading | text extraction, no OCR |
| `brief.docx` | any Word file | mammoth |
| `notes.txt` | a few lines of Greek | the text route (needs PR 4) |
| `.DS_Store` | macOS adds it | must not appear in the listing |

### 4. In Claude Code

Ask, in your own words: *"Create a matter called `Smoke test 2026-10-20`, civil, then upload the files in `/Users/<you>/Desktop/smoke` to it."*

What a **pass** looks like, in order:

1. `create_matter` answers `Created matter #<n> "Smoke test 2026-10-20" — https://…/matters/<n>` — **or**, on the first call ever, the sign-in text: *"Sign in to DIKIGOROS first: open https://…/activate?user_code=XXXX-XXXX and enter code XXXX-XXXX (valid 15 minutes). Then call this tool again."* The browser opens on that page; approve with the Firm test account; ask Claude to try again. (First call also downloads the two native packages — about 15 MB — the stderr log of the server says `installing @napi-rs/canvas 1.0.11` etc.; Claude Code shows nothing for it.)
2. `upload_to_matter` first answers the listing — one line per file, `.DS_Store` absent — ending with *"Nothing has been uploaded. Call again with confirm: true and plan_digest "…" …"*. Nothing has reached the server yet (check: the matter page shows no documents).
3. Claude calls again with `confirm: true`; the answer lists each file as `ready` (the scan may take a minute: one OCR batch), then `Matter #<n>: https://…`.
4. On the matter page in the web app: the documents are there, `ready`, the scan's text is the transcription (it contains `ΠΑΝΕΠΙΣΤΗΜΙΟΥ` and `2010`, not a sentence about an unreadable image), the DOCX and PDF texts are searchable in the matter chat. For the staging DB: `SELECT filename, ingest_status, ocr_applied FROM auth_matter_documents WHERE matter_id = <n>` shows every file `ready` and `ocr_applied = true` for the scan only.
5. Ask for the same upload again: every file comes back `duplicate` (dedupe on sha256), nothing is re-sent.
6. Ask for an upload with `role: "exhibit"` on a new file: the result's `role_applied` is true (needs PR 4) and the document shows the role on the matter page.

### 5. In Cowork

Install the same plugin in Cowork (Settings → Plugins → add the marketplace `dikigoros-ai/claude-plugins` → install `dikigoros`), open a session **on the Mac** (the local server only runs for local sessions), and repeat step 4 with the folder. Expected: identical behaviour; if Cowork reports *"spawn node ENOENT"*, Node is not on the PATH Cowork starts processes with — install Node 22 LTS from the official installer (which puts it in `/usr/local/bin`) and retry.

### 6. Clean up

Delete the smoke-test matter on the matter page (deletion is deliberately not possible through the helper).

## Passed / failed

**Passed:** steps 4.1–4.5 as described in both clients, the scan's text correct, `.DS_Store` never listed, nothing uploaded before `confirm: true`.

**Failed:** write down the exact tool answer (it never contains a token) and the server log line, and file it as an issue in this repository. Known shapes: *"The helper is not configured"* (gate 01 / step 2), *"Could not reach the sign-in service"* (the Auth0 domain or network), *"The server refused the helper's sign-in for …"* (a route not on the allowlist — PR 1/PR 4 not deployed), *"Unsupported platform"* (not a Mac/Linux/Windows build the helper knows), *"native_runtime_unavailable"* (the registry download failed — check the network; `DIKIGOROS_HELPER_NATIVE_DIR` is the offline path).
