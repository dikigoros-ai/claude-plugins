# Changelog

## 0.2.0 (unreleased)

Set a project folder up as a new matter, with a file picker.

- The skill **`dikigoros:init-matter`** (`/dikigoros:init-matter [folder]`): scans a project folder, proposes the
  matter's fields and the core documents, opens the picker, and on the lawyer's confirmation creates the matter and
  uploads the files; where the host shows no picker, the same in the chat with a listing and a confirm step.
- New helper tools: `scan_project` (recursive, read-only: depth 8, 5,000 entries, symlinks only inside the folder;
  sends nothing about the files), `show_project_picker`, `init_matter`; and, for the picker only, `load_picker` and
  `save_selection`.
- The picker, an MCP App at `ui://dikigoros/project-picker`: the matter's fields, the folder's tree with tri-state
  folders, ineligible files greyed with their reason, a counter against the plan's documents per matter, ticking past
  it refused; English and Greek; the host's theme; no network access (an empty CSP).
- `.dikigoros/matter.json` links the folder to its matter, written before the first upload and after each file; a
  re-run offers only the files not yet uploaded, into the same matter. Same-named files from different subfolders are
  stored as `Name (2).pdf`.
- Upload outcomes carry the file's SHA-256 (PDF and DOCX).
- `@modelcontextprotocol/ext-apps` 2.0.4 (bundled into the server and the picker), `@modelcontextprotocol/client`
  2.3.1 pinned beside it.
- Roles and sides: dikigoros.ai keeps the document `PATCH` off the helper's allowlist (owner's decision), so
  `role_applied` is always false.

## 0.1.0

Initial release.

**Not yet live.** It waits for the main app's PR 1 (the routes) and PR 4 (two more routes), and the Auth0
application. Until the application's client id is set in `src/config.ts`, every tool call answers "The helper is not
configured". PR 4 adds `POST /api/matters/[id]/documents/text` and `PATCH /api/matters/[id]/documents/[docId]` to the
connector-token allowlist ([docs/assumed-routes.md](docs/assumed-routes.md)).

- The `dikigoros-ai` marketplace and its `dikigoros` plugin: the remote DIKIGOROS connector
  (`https://dikigoros.ai/mcp`) and the local stdio server `dikigoros-upload`.
- `upload_to_matter`: lists the `.pdf`, `.docx`, `.txt` and `.md` files that the given paths name, and uploads them
  into a matter only on a second call with `confirm: true` and the listing's `plan_digest`; optionally with a role
  and a side.
- `create_matter`: creates a matter with a title and an optional type, case reference and description.
- Sign-in with the Auth0 device authorization grant; the refresh token is kept in the OS keychain.
- The web uploader's pipeline, in Node.js: the SHA-256, the file into the private blob store, the text extraction
  and the rendering of scanned pages on this computer, the ingest, and the processing followed until ready. A file
  already in the matter is reported as a duplicate; an upload a previous run left unfinished is resumed.
- The two native components, for page rendering and the keychain, installed on first use from a pinned,
  sha512-verified lock.
