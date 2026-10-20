# DIKIGOROS AI plugin for Claude

The `dikigoros` plugin connects Claude to [DIKIGOROS AI](https://dikigoros.ai). It holds two MCP servers:

- **`dikigoros`**, the remote connector at `https://dikigoros.ai/mcp`: Cyprus case law, legislation and matters. It
  runs on dikigoros.ai; this repository holds only its address.
- **`dikigoros-upload`**, the local helper: a Node.js server bundled in this repository
  (`plugins/dikigoros/server/`) that Claude starts on your computer. It uploads files from your computer into a
  DIKIGOROS matter, through the same routes and steps as the uploader on dikigoros.ai. The remote connector cannot do
  this: MCP has no channel for files.

> **0.1.0 is not live yet.** Until the DIKIGOROS Auth0 application exists and its client id is set in
> `src/config.ts`, the helper answers every tool call with "The helper is not configured (DIKIGOROS_AUTH0_CLIENT_ID is
> empty)." That is expected in this release.
> Uploads of `.txt` and `.md` files, and roles and sides, also wait for dikigoros.ai to accept the helper's sign-in
> on two more routes ([docs/assumed-routes.md](docs/assumed-routes.md)).

## Install

In Claude Code:

```
/plugin marketplace add dikigoros-ai/claude-plugins
/plugin install dikigoros
```

or from a shell:

```
claude plugin marketplace add dikigoros-ai/claude-plugins
claude plugin install dikigoros@dikigoros-ai
```

The local helper needs **Node.js 22.13 or later** on the `PATH` that Claude Code or Cowork starts it with: the
plugin runs it as `node ${CLAUDE_PLUGIN_ROOT}/server/dikigoros-upload.mjs`, and an older Node.js gets one line,
"dikigoros-upload needs Node.js 22.13 or later; found <version>", and nothing else. Claude Code always runs it; Cowork
runs it when the session runs on your computer; Claude on the web lists the remote connector and ignores the local
helper.

The helper works with a DIKIGOROS account whose plan includes Matters.

### First use

The first tool call of each helper process makes sure two native components are installed: `@napi-rs/canvas`,
which renders scanned PDF pages, and `@napi-rs/keyring`, which reaches the OS keychain. The bundle cannot carry
them, so it downloads them from registry.npmjs.org: `@napi-rs/canvas` 1.0.11, `@napi-rs/keyring` 2.1.2 and the
package of each for your platform, about 15 MB compressed. The exact versions and their sha512 integrity are pinned
in `src/native/lock.generated.json`; each download is checked against it before anything is written. They are
installed into `$CLAUDE_PLUGIN_DATA/native/<lock hash>/node_modules` (`~/.dikigoros/helper/native/…` when
`CLAUDE_PLUGIN_DATA` is not set), where later processes find them.

Each package's download may take at most 5 minutes: the 13 MB canvas package needs about 43 KB/s. A failed install
is tried again on the next tool call. On a machine that cannot download them, set `DIKIGOROS_HELPER_NATIVE_DIR` to a
`node_modules` directory that already holds both packages and their platform packages; nothing is downloaded then.

Supported platforms: macOS on Apple silicon and Intel (`darwin-arm64`, `darwin-x64`), Linux with glibc on x64 and
arm64 (`linux-x64-gnu`, `linux-arm64-gnu`), Windows on x64 and arm64 (`win32-x64-msvc`, `win32-arm64-msvc`). Linux
with musl (Alpine, for one) is not supported.

## What the helper does

| Tool | Inputs | What it does |
|---|---|---|
| `upload_to_matter` | `matter_id`; `paths`: 1 to 50 absolute paths of files or folders; optional `role`, `side`, `confirm`, `plan_digest` | Lists the files the paths name; with `confirm: true`, uploads them into the matter |
| `create_matter` | `title`; optional `type` (`civil`, `criminal`, `interim_application`, `appeal`, `other`), `case_reference`, `description` | Creates a matter and answers with its number and link |

### The confirm step

The first call lists what would be uploaded and uploads nothing. It checks the account and the matter first, so a
matter that is not there is said before any list. The list starts with how to confirm it, then has one line per file
to upload (name · size · type · upload) and per file skipped (skip and why; past the first 25, the skipped files are
counted by reason), and ends with the matter and how many documents it holds of the plan's limit:

```json
{ "matter_id": 12, "paths": ["/Users/you/Documents/Matter 12"] }
```

```
Nothing has been uploaded. Call again with confirm: true and plan_digest "3f2a9c0d1e4b5a67" to upload the 3 file(s) marked upload.
brief.docx · 20.0 KB · docx · upload
claim.pdf · 47.1 KB · pdf · upload
notes.txt · 512 B · text · upload
photo.jpg · 1.2 MB · — · skip (unsupported_type)
Matter #12 "Georgiou v Petrou": 4 of 50 documents
```

The second call, with `confirm: true` and that `plan_digest`, uploads the files marked upload one after another and
reports each:

```json
{ "matter_id": 12, "paths": ["/Users/you/Documents/Matter 12"], "confirm": true, "plan_digest": "3f2a9c0d1e4b5a67" }
```

```
brief.docx: ready
claim.pdf: ready
notes.txt: duplicate — This file is already in the matter (document #31).
Matter #12: https://dikigoros.ai/matters/12
```

The `plan_digest` is required: `confirm: true` without one lists the files again and uploads nothing. If the files
changed between the two calls (one added, removed or of another size), the second call uploads nothing and lists them
again with a new `plan_digest`.

Each file ends as one of:

- `ready`: uploaded and processed.
- `duplicate`: the same bytes are already in the matter.
- `processing`: still being processed after 10 minutes; the matter page carries on with it, or call again later.
- `skipped`: a `.txt` or `.md` file that is empty, longer than 200,000 characters, or neither UTF-8 nor Windows Greek
  text; or a file the call did not start, as the call was cancelled (`cancelled`) or had run for 20 minutes
  (`call_budget`): call again, and the files uploaded meanwhile are found as duplicates or resumed.
- `failed`, with the reason (its code, when there is no sentence for it).

While the second call runs, the helper sends MCP progress notifications when the client asks for them: one as it
starts each file, and one each time the count of pages waiting for OCR changes. A call the client cancels starts no
further file.

Each file goes the way the uploader on dikigoros.ai sends it. Its SHA-256 is computed on this computer. A PDF or a
DOCX is put in the DIKIGOROS private blob store under the matter, with a client token dikigoros.ai issues for that
one file. Its text is extracted on this computer (pdf.js for PDF, mammoth for DOCX), and each PDF page without usable
text is rendered as a JPEG for the server's OCR. The document is then registered with dikigoros.ai, its text handed
over, and its processing followed until it is ready. A `.txt` or `.md` file is sent as its text. A file an earlier
call left unfinished is picked up where it stopped rather than reported as a duplicate.

### Roles and sides

`role` and `side`, when given, apply to every file of the call. They are set after processing finishes, once the
server has made its own suggestion, which they then override; if the server refuses to set them, the result says
`role_applied: false`. The upload goes on whatever the server answers: the file stays uploaded and processed. A
document still processing when the call ends is left without them (`role_applied: false`). A file already in the
matter keeps its own, unless an earlier call left it unfinished: then it gets them once its processing finishes.

- Roles: `statement_of_claim`, `defense`, `reply`, `affidavit`, `opposition`, `witness_statement`, `exhibit`,
  `interim_application`, `court_order`, `correspondence`, `other`, `written_submission`, `judgment`,
  `expert_report`, `minutes`, `notice`, `bundle`.
- Sides: `ours`, `theirs`, `neutral`.

## Signing in

The helper signs in with the Auth0 device authorization grant. The first tool call without a sign-in answers with a
link and a code, and opens the link in your browser unless `DIKIGOROS_NO_BROWSER=1`:

```
Sign in to DIKIGOROS first: open https://<tenant>/activate?user_code=ABCD-EFGH and enter code ABCD-EFGH (valid 15 minutes). Then call this tool again.
```

Sign in and approve in the browser, then call the tool again; a call before you approve answers with the same link
and code. The helper asks for the scopes `openid offline_access matters:read matters:write account:read`, for the
audience `https://dikigoros.ai/mcp`, the remote connector's.

### Where the sign-in is kept

The refresh token is kept in the OS keychain, never in a file on disk: service `dikigoros-upload-helper`, account
the DIKIGOROS address (`https://dikigoros.ai`). The access token is kept in the helper's memory only.

- macOS: the login keychain (Keychain Access).
- Windows: Credential Manager, under Windows Credentials.
- Linux: the Secret Service (GNOME Keyring, KWallet, KeePassXC and others). Without one, `@napi-rs/keyring` falls
  back to the kernel keyring, which does not survive a restart of the computer.

When no keychain can be used, the sign-in is kept in memory for as long as the helper runs, and each upload result
says so.

To sign out, delete the keychain entry:

- macOS: `security delete-generic-password -s dikigoros-upload-helper -a https://dikigoros.ai`, or delete the
  `dikigoros-upload-helper` item in Keychain Access.
- Windows: in Credential Manager, remove the Windows credential whose name contains `dikigoros-upload-helper`.
- Linux: remove the `dikigoros-upload-helper` item in your keyring manager (Passwords and Keys on GNOME, for one).

A helper that is running keeps its access token until the token expires or Claude is restarted. When Auth0 refuses
the stored refresh token, the helper deletes the entry itself and answers with a new sign-in.

## What leaves this computer, and when

| When | What | To |
|---|---|---|
| Sign-in | The client id, the scopes and the audience; then the device code, until you approve in the browser | The Auth0 tenant (`DIKIGOROS_AUTH0_DOMAIN`) |
| Token refresh: when the access token has a minute or less left, or dikigoros.ai refused it | The client id and the refresh token | The Auth0 tenant |
| The first tool call, until the native components are installed | Requests for the pinned packages; what comes back is checked against the committed lock | registry.npmjs.org |
| `create_matter` | The title, type, case reference and description | `https://dikigoros.ai` |
| `upload_to_matter` with `confirm: true` | Each PDF's and DOCX's bytes, and the JPEG of each page that needs OCR (scanned pages) | The DIKIGOROS private blob store (Vercel Blob, EU), straight from this computer |
| `upload_to_matter` with `confirm: true` | Each file's name, size, SHA-256 and first 8 bytes; its extracted text (the manifest); a `.txt` or `.md` file's text; the role and side, when given | `https://dikigoros.ai` |

Every request to dikigoros.ai carries the access token. The first call of `upload_to_matter`, the listing, reads the
files' names, sizes and first bytes on this computer and sends nothing about them: it asks dikigoros.ai for the
account and the matter only. Nothing else leaves this computer: the helper sends no telemetry.

## Configuration

The helper reads these from the environment Claude starts it with, to which the plugin manifest adds nothing, or from
your shell when you run it yourself. A variable set to an empty value counts as unset. The defaults are in
`src/config.ts`: the production client id is set there at release time, and the environment overrides it.

| Variable | Default | Meaning |
|---|---|---|
| `DIKIGOROS_BASE_URL` | `https://dikigoros.ai` | The DIKIGOROS address. Only `https://dikigoros.ai` and `http://localhost:3000` (development) are accepted, a trailing slash aside; with any other value the helper prints one line and exits. |
| `DIKIGOROS_AUTH0_DOMAIN` | `dikigoros-prod.eu.auth0.com`; for `http://localhost:3000`, the staging tenant `dikigoros-staging.eu.auth0.com` | The Auth0 tenant the helper signs in with. |
| `DIKIGOROS_AUTH0_CLIENT_ID` | the production application's, set in `src/config.ts` at release time (empty in 0.1.0); empty for `http://localhost:3000` | The Auth0 application's client id. While it is empty, every tool call answers "The helper is not configured". |
| `CLAUDE_PLUGIN_DATA` | `~/.dikigoros/helper` when unset | The plugin's data directory: where the helper installs the native components. |
| `DIKIGOROS_NO_BROWSER` | unset | `1`: do not open the sign-in link in the browser; the result still carries it. |
| `DIKIGOROS_HELPER_NATIVE_DIR` | unset | A `node_modules` directory that already holds `@napi-rs/canvas` and `@napi-rs/keyring` with their platform packages, used instead of downloading them. |
| `VERCEL_BLOB_RETRIES` | `2`, set by the helper when unset | How often the blob store client retries a failed upload. |

The helper removes `VERCEL_BLOB_API_URL`, `NEXT_PUBLIC_VERCEL_BLOB_API_URL`, `VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API`
and `NEXT_PUBLIC_VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API` from its environment when it starts: set in the shell for
another project, they would send the files and their upload tokens somewhere other than the DIKIGOROS store.

## Limits

- File types: `.pdf`, `.docx`, `.txt` and `.md` only. A PDF or a DOCX must also start with that type's bytes; a file
  whose bytes contradict its extension is skipped.
- At most 50 MB per file, and 200,000 characters per `.txt` or `.md` file. Empty files are skipped.
- At most 50 paths and 100 files per call. The files past the 100th are skipped (`too_many_files`) without being
  read, and a listing names at most 25 skipped files, counting the others by reason.
- A call that has run for 20 minutes starts no further file; the next call picks up where it stopped.
- Paths must be absolute: a relative path, or one starting with `~`, is skipped (`not_absolute`).
- A folder stands for the files directly in it: subfolders are not entered.
- Dotfiles are skipped: a folder's are left out of the listing, and one named directly is listed as skipped.
- A file whose real path, links followed, leads out of the folder that was named (for a file named directly, the
  folder it is in) is skipped.
- The plan's limit of documents per matter: a matter that holds as many already takes nothing, and the call says so
  before uploading anything. A matter with room for some of the files takes them; each file past the limit then fails
  on its own (`document_limit_reached`).
- A file whose bytes are already in the matter is reported as a duplicate: no second document is created. Its bytes
  still go to the blob store first, as with the uploader on dikigoros.ai. When an earlier call left that document
  unfinished, it is picked up where it stopped instead.

## Troubleshooting

**`spawn node ENOENT` in Cowork or Claude Desktop.** The app could not find `node` on the `PATH` it starts the helper
with. Install Node.js 22 LTS (22.13 or later) for the whole system, with the installer from nodejs.org for instance,
and restart the app. A Node.js installed for your terminal only, through a version manager for instance, is not on
the `PATH` of an app started from the Dock, the Start menu or the desktop.

**`dikigoros-upload needs Node.js 22.13 or later; found <version>`.** The `node` on the `PATH` the app starts the
helper with is older than 22.13. Install Node.js 22 LTS (22.13 or later), as above, and restart the app.

**`Unsupported platform: <platform>-<arch>`.** The native components exist for the six platforms listed under
[First use](#first-use) only. Elsewhere PDFs fail and the sign-in is kept in memory only; DOCX, TXT and MD files
still upload.

**PDFs fail with `native_runtime_unavailable`.** The native components could not be installed; the message says
why (`Download failed for <package>: …`, `Integrity mismatch for <package>`). The install is tried again on the next
call. The downloads must reach registry.npmjs.org and finish within 5 minutes each; otherwise provide the packages
through `DIKIGOROS_HELPER_NATIVE_DIR`.

**`The OS keychain is not available on this machine (…); the sign-in is kept in memory for this session only.`**
The helper could not use the keychain, so you sign in again each time the helper starts. The reason in brackets says
why; it also appears when the native components could not be installed, as the keychain is reached through one of
them. The fallback lasts as long as the helper process: once the cause is fixed, restart Claude.

**`The helper is not configured (DIKIGOROS_AUTH0_CLIENT_ID is empty).`** Expected in 0.1.0 until the DIKIGOROS Auth0
application exists (see the note at the top).

**`Could not reach the sign-in service (…). Nothing was changed; try again in a moment.`** The Auth0 tenant could not
be reached, gave no usable answer or refused to start a sign-in, or the keychain could not be read. A stored sign-in
is kept; call the tool again later.

**`The server refused the helper's sign-in for <METHOD> <path>; this route may not accept helper tokens yet
(docs/assumed-routes.md)`.** dikigoros.ai refused the helper's token on that route, even after a refresh. In 0.1.0
this is expected for `POST /api/matters/{id}/documents/text`, the route of every `.txt` and `.md` file, until
dikigoros.ai accepts helper tokens there ([docs/assumed-routes.md](docs/assumed-routes.md)). On another route it can
mean that the sign-in is no longer valid.

## Development

Requires Node.js 22.13 or later.

```
npm ci                                       # dependencies, the native components among them for the tests
npm run check                                # lint, typecheck and the tests
npm run build                                # the bundle and pdf.js's files into plugins/dikigoros/server/
claude plugin validate ./plugins/dikigoros   # the plugin manifest
claude plugin validate .                     # the marketplace
```

The tests run offline. `test/integration/upload-flow.test.ts` runs the whole upload against an in-memory DIKIGOROS
API and blob store on 127.0.0.1 (`test/support/fake-api.ts`). `test/plugin-smoke.test.ts` starts the committed
bundle: after changing `src/`, build before testing.

`node plugins/dikigoros/server/dikigoros-upload.mjs --extract-check <file.pdf>` starts no server: it reads the PDF
with the bundle's pdf.js and prints one line, `{"pages":…,"needsOcr":…,"images":…}`, a check that page rendering
works on this machine. It installs the native components first, unless `DIKIGOROS_HELPER_NATIVE_DIR` is set.

`src/` holds the helper's sources, `test/` the tests and their fixtures, `scripts/` the build and the pinning of the
native components, `plugins/dikigoros/` the plugin as Claude installs it; its `server/` directory is generated by the
build. The routes the helper assumes: [docs/assumed-routes.md](docs/assumed-routes.md). Releases:
[docs/release-process.md](docs/release-process.md). Changes: [CHANGELOG.md](CHANGELOG.md).

## Licence

MIT; see [LICENSE](LICENSE). The bundled server holds code of other projects, under their own licences:
`plugins/dikigoros/server/THIRD_PARTY_NOTICES.md` lists them, and `dikigoros-upload.mjs.LEGAL.txt` the licence
comments of the bundled code.
