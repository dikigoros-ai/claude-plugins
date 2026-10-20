# Changelog

## 0.1.0

Initial release.

**Not yet live.** It waits for the DIKIGOROS Auth0 application: until its client id is set as
`DIKIGOROS_AUTH0_CLIENT_ID` in `plugins/dikigoros/.claude-plugin/plugin.json`, every tool call answers "The helper
is not configured". It also waits for the main app's PR 4, which adds `POST /api/matters/[id]/documents/text` and
`PATCH /api/matters/[id]/documents/[docId]` to its connector-token allowlist ([docs/assumed-routes.md](docs/assumed-routes.md)).

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
