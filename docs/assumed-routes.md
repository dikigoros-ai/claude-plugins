# Routes the helper assumes

The DIKIGOROS routes the local helper (`dikigoros-upload`) calls, as this release assumes them. They are taken from
the REST client (`src/api/client.ts`), the document pipeline (`src/pipeline/upload-document.ts`), the tool handlers
(`src/server/tools.ts`) and the requests the integration test records against the fake API
(`test/integration/upload-flow.test.ts`, `test/support/fake-api.ts`). The shapes were checked against the main app's
routes (`dikigoros-ai/dikigoros-ai` at `37f39ac5`, 2026-10-19: `app/api/matters/**` and `app/auth/current-user`).
Nothing is imported from that repository: when a route changes there, this file, the client and the fake change with
it.

The helper's access token is an Auth0 token for the audience `https://dikigoros.ai/mcp`, the remote connector's. The
main app accepts such a token only on the routes of its connector-token allowlist (`CONNECTOR_TOKEN_ROUTES` in
`lib/mcp/auth.ts`), each with the scope it names.

> **Two routes the helper calls are not in PR 1's `CONNECTOR_TOKEN_ROUTES` and must be added by the main series'
> PR 4:**
>
> - **`POST /api/matters/[id]/documents/text` (`matters:write`).** Every `.txt` and `.md` upload. Until then each
>   fails with "The server refused the helper's sign-in for POST /api/matters/{id}/documents/text; …".
> - **`PATCH /api/matters/[id]/documents/[docId]` (`matters:write`, role and side only).** A `role` or `side` given
>   to `upload_to_matter`. Until then they are left unset (`role_applied: false`) and the upload goes on.

The spec's §5.5 says "no document PATCH through the connector at launch" for the MCP tools, so allowlisting the
`PATCH` for helper tokens is an owner decision for PR 4. If it is declined, the helper still accepts `role` and `side`
and always reports `role_applied: false`.

## Every request

- `Authorization: Bearer <access token>` and `Accept: application/json`; with a body, `Content-Type:
  application/json` and the body as JSON.
- Sent only to the base URL (`https://dikigoros.ai`, or `http://localhost:3000` in development). A redirect is
  refused, never followed.
- A 401 is answered once: the helper drops its access token, refreshes it with Auth0 and sends the request again. A
  second 401 stands (see [Refusals](#refusals)).
- An error answer's `error` string is its code (`http_<status>` when there is none); the rest of its body, `limit` or
  `documentId` for instance, is kept for the sentence. A success answer the route does not send is `invalid_response`.

## The routes

Scopes: `matters:read` for the `GET`s under `/api/matters`, `matters:write` for the `POST`s and the `PATCH`,
`account:read` for `/auth/current-user`. `…` stands for `/api/matters/{id}/documents`.

| Method | Path | Scope | Request body | Success | Errors handled |
|---|---|---|---|---|---|
| `GET` | `/auth/current-user` | `account:read` | none | 200, the user: `id`, `email`, `plan`, `entitlements: { mattersAccess, docsPerMatter, activeMatters, tier }` and more, which is ignored | 401 after the retry: the session is forgotten and a new sign-in starts. `mattersAccess: false`: the plan sentence; nothing is uploaded |
| `GET` | `/api/matters` | `matters:read` | none | 200 `{ matters: [{ id, title, caseReference, matterType, status, updatedAt, documentCount }] }` | In the client only: no tool calls it in 0.1.0 |
| `POST` | `/api/matters` | `matters:write` | `title`; optional `caseReference`, `matterType`, `description` | 201 `{ matter: { id, userId, title, caseReference, matterType, description, status, deletedAt, createdAt, updatedAt } }` | 401 after the retry: the session is forgotten and a new sign-in starts. 429 `matter_limit_reached` (`limit`), 403 `entitlement_required`: their sentences |
| `GET` | `/api/matters/{id}` | `matters:read` | none | 200 `{ matter, documents, pins, notes, artifacts }`; the helper counts `documents` against `docsPerMatter` | 404: "Matter not found (or not yours)."; nothing is uploaded |
| `POST` | `…/upload` | `matters:write` | [the client-token event](#the-client-token-event) | 200 `{ type: "blob.generate-client-token", clientToken }` | Any refusal fails that file |
| `POST` | `…` | `matters:write` | `filename`, `mimeType`, `sizeBytes`, `sha256` (64 hex), `blobUrl`, `headBytesBase64` (the first 8 bytes) | 201 `{ document }`, `ingestStatus: "pending"` | 409 `duplicate_document` (`documentId`): see [Files already in the matter](#files-already-in-the-matter). 429 `document_limit_reached` (`limit`), 415 `Unsupported file type`: the file fails |
| `POST` | `…/text` | `matters:write`, **not allowlisted** | `filename`, `text` | 201 `{ document }`, `ingestStatus: "processing"`, one page | As for `POST …` |
| `PATCH` | `…/{docId}` | `matters:write`, **not allowlisted**, role and side only | `role`, `side` (one or both), sent once the processing is `ready`, to a new document or a resumed one | 200 `{ document }` | Any refusal, or no answer: role and side left unset (`role_applied: false`), one log line; the file stays `ready` |
| `POST` | `…/{docId}/ingest` | `matters:write` | [the manifest](#the-manifest) | 200 `{ ocrPages }` | `too_many_ocr_pages` (`limit`), `manifest_too_large`, `Weekly usage limit reached`: the file fails with their sentences |
| `POST` | `…/{docId}/process` | `matters:write` | none | 200 `{ status, ocrRemaining, suggested?, errorCode?, document? }` | 409 `processing_in_progress`, a 5xx, a 429 or no answer: polled again. `status: "failed"`: the file fails with `errorCode` (`no_text_extracted`), else `processing_failed` |
| `GET` | `…/{docId}` | `matters:read` | none | 200 `{ document }` with `ingestStatus`, `pageCount` and `pages` | 401, 403 or 404: the file is reported as a duplicate of that document |

The `document` a create or a patch answers with is `{ id, matterId, filename, mimeType, sizeBytes, role, side,
roleConfirmed, guide, origin, ingestStatus, ingestError, ocrApplied, pageCount, createdAt }`, never the blob URL, the
hash, the pages or the text.

The integration test exercises every row but `GET /api/matters`, which no tool calls, and the `PATCH`, which only a
call with a `role` or a `side` makes.

## Refusals

A 401 that the retry with a fresh token did not get past means, by route:

- `GET /auth/current-user`, `POST /api/matters`: a dead session. It is forgotten (the keychain entry deleted) and the
  result is a new sign-in.
- `GET /api/matters/{id}`: "Sign in again: call the tool once more and follow the sign-in instructions."
- The routes of one file's upload (`…/upload`, `…`, `…/text`, `…/{docId}/ingest`, `…/{docId}/process`): that file
  fails with code `unauthorized` and "The server refused the helper's sign-in for <METHOD> <path>; this route may not
  accept helper tokens yet (docs/assumed-routes.md)"; the other files go on. The route may not be on the allowlist,
  or the session is dead.

Other refusals become these sentences (`src/api/errors.ts`), in the call's result or in the failed file's line:

| Code | Sentence |
|---|---|
| `entitlement_required` | This needs the Firm plan (Matters). Plans: https://dikigoros.ai/pricing |
| `account_suspended` | This DIKIGOROS account has been suspended. |
| `email_not_verified` | Verify this DIKIGOROS account's email address first, then try again. |
| `not_signed_in`, or any other 401 | Sign in again: call the tool once more and follow the sign-in instructions. |
| `matter_limit_reached` | Matter limit reached (`limit` active matters). |
| `document_limit_reached` | Document limit reached (`limit` per matter). |
| `duplicate_document` | This file is already in the matter (document #`documentId`). |
| `Weekly usage limit reached` | The weekly usage allowance is used up; it resets on Sunday 00:00 UTC. |
| `too_many_ocr_pages` | Too many pages need OCR (at most `limit` per document); split the file into smaller ones. |
| `manifest_too_large` | The extracted text is too large to store; split the file into smaller ones. |
| `processing_in_progress` | The document is already being processed; try again in a moment. |
| any other 404 | Matter not found (or not yours). |
| anything else | `<status> <code>` |

A request that gets no answer: for `create_matter`, and for the account and matter checks before the uploads, the
call fails with "Could not reach DIKIGOROS (…)"; for the routes of one file's upload, that file fails with code
`network`, but for a poll of `…/{docId}/process`, which is made again.

## The blob store

### The client-token event

```json
{
  "type": "blob.generate-client-token",
  "payload": { "pathname": "matters/u7/m12/claim.pdf", "clientPayload": null, "multipart": false }
}
```

This is the event `@vercel/blob/client` sends to its `handleUploadUrl`, posted to `POST …/upload` with the session's
bearer, once for each blob. A file's pathname is `matters/u<userId>/m<matterId>/<file name>`, the name verbatim
(spaces and Greek letters as they are); the JPEG of page n is `matters/u<userId>/m<matterId>/pages/p<n>.jpg`. The
answer's `clientToken` starts with `vercel_blob_client_` (the SDK refuses any other) and lets the store take that one
pathname. As the main app implements the route, it refuses a pathname outside the caller's matter prefix or holding
an empty, `.` or `..` segment, and its token allows `application/pdf`,
`application/vnd.openxmlformats-officedocument.wordprocessingml.document` and `image/jpeg`, up to 50 MB, with a
random suffix added to the stored name.

### The store's PUT

`PUT <store API>/?pathname=<the pathname, URL-encoded>`, where the store API is the SDK's default
(`https://vercel.com/api/blob`). `VERCEL_BLOB_API_URL` (or `NEXT_PUBLIC_VERCEL_BLOB_API_URL`) would name another: the
helper removes both from its environment when it starts, with the two `…PROXY_THROUGH_ALTERNATIVE_API` variables, and
only the tests, which run the pipeline without the server, point the SDK at their fake store. Headers:
`authorization: Bearer <client token>`, `x-api-version`, `x-content-type: <the type>`, `x-vercel-blob-access: private`.
The body is the bytes, sent from this computer to the store, never through dikigoros.ai.

The answer carries the blob's `url` on the store's private host (`https://<store id>.private.blob.vercel-storage.com/…`,
the pathname with the store's suffix), with `pathname`, `contentType` and `contentDisposition`. The helper registers
that `url`: as `blobUrl` for a file, as `imageBlobKey` for a page. The documents route takes a `blobUrl` only under
the caller's matter prefix on the store's private host, and checks that the stored blob's size is `sizeBytes`.

The SDK retries a connection failure, or an internal error of the store, `VERCEL_BLOB_RETRIES` times (the helper sets
2 when it is unset). An upload still running after 10 minutes is aborted. A failed PUT fails the file with
`blob_upload_failed` and the first line of the SDK's message.

## The manifest

`POST …/{docId}/ingest` takes the text extracted on this computer:

```ts
type IngestManifest =
  | { kind: "pdf"; pages: Array<{ page: number; text: string; needsOcr: boolean; imageBlobKey?: string }> }
  | { kind: "docx"; fullText: string };
```

- `pdf`: one entry per page, from 1. `text` is the page's text layer as pdf.js reads it, its pieces joined by their
  place on the page. `needsOcr` is true for a page with fewer than 40 characters of text, spaces aside, or fewer than
  half of them letters (Latin or Greek). Such a page is rendered 1600 px wide (smaller, the same shape, when that would
  pass 25 million pixels: a very tall page) and its JPEG (quality 80) put in the store; `imageBlobKey` is that blob's
  URL, absent for a page that rendered blank. When every page needs OCR and none
  rendered anything, no document is registered: the file fails with `no_text_extracted`, its bytes already in the
  store, as with the web uploader.
- `docx`: `fullText` is mammoth's raw text of the document, each paragraph followed by a blank line.

scan.pdf of the integration test, one scanned page:

```json
{
  "kind": "pdf",
  "pages": [
    {
      "page": 1,
      "text": "",
      "needsOcr": true,
      "imageBlobKey": "https://teststore.private.blob.vercel-storage.com/matters/u7/m1/pages/p1.jpg-e08c0d2b"
    }
  ]
}
```

## The text document

`POST …/text` takes `{ filename, text }`. The file is decoded as UTF-8, or as Windows Greek (windows-1253) when it is
not valid UTF-8, and normalised: the byte-order mark removed, CRLF and CR made LF, the ends trimmed, U+0000 replaced
by U+FFFD. A file that decodes neither way, is empty after that, or is longer than 200,000 characters is skipped
(`text_encoding`, `text_empty`, `text_too_long`) without a request. The server hashes the normalised text itself, so
the same text twice is a duplicate. The row is created processing, with one page, so there is no ingest: the helper
goes straight to polling.

## Processing

`POST …/{docId}/process` is polled every 1.5 seconds until it answers `ready` or `failed`; `ocrRemaining` is logged as
progress. After 10 minutes of polling the file is reported `processing`, with the last `ocrRemaining`: the row stays,
and the matter page or a later call resumes it. On `ready`, `document` is `{ id, filename, role, side,
roleConfirmed, ingestStatus, pageCount, ocrApplied, extractedText }`, of which the helper reads `pageCount`. Then,
when the call gave a role or a side, the helper sends the `PATCH`: the server's role suggestion and source guide have
run by then, and the lawyer's choice overrides the suggestion.

## Files already in the matter

When `POST …` or `POST …/text` answers 409 `duplicate_document`, `documentId` names the document that holds the same
bytes (or the same text). The helper reads it with `GET …/{docId}`:

- `ready`: the file is reported `duplicate`, with that id.
- `processing` or `failed`: its processing is resumed and polled as above.
- `pending`, left so by a run that stopped between registering and ingesting: the manifest just built is ingested
  into it, and it is polled.

A role or side given in the call is set on a resumed document (processing, failed or pending) once it is `ready`, as
on a new one; a `ready` twin keeps its own. A PDF or DOCX is put in the store before `POST …`, so a file already in
the matter is put there once more, as with the web uploader.

## The calls, in order

What the integration test records for a folder of `brief.docx`, `claim.pdf`, `notes.txt` and `scan.pdf` (one
scanned page), uploaded into matter 1 of user 7. `…` is `/api/matters/1/documents`; the fake answers `processing`
twice before `ready`. The first call of `upload_to_matter`, without `confirm`, makes no request at all.

```
POST /api/matters                      create_matter
GET  /auth/current-user                upload_to_matter, confirm: true
GET  /api/matters/1
POST …/upload                          brief.docx
PUT  store  matters/u7/m1/brief.docx
POST …                                 201, document 1
POST …/1/ingest                        kind docx
POST …/1/process  ×3
POST …/upload                          claim.pdf
PUT  store  matters/u7/m1/claim.pdf
POST …                                 201, document 2
POST …/2/ingest                        kind pdf, no page needing OCR
POST …/2/process  ×3
POST …/text                            notes.txt: 201, document 3
POST …/3/process  ×3
POST …/upload                          scan.pdf
PUT  store  matters/u7/m1/scan.pdf
POST …/upload                          its page 1
PUT  store  matters/u7/m1/pages/p1.jpg
POST …                                 201, document 4
POST …/4/ingest                        kind pdf, page 1 needing OCR, with its imageBlobKey
POST …/4/process  ×3
```

The same confirmed call made again: each PDF and DOCX is put in the store again (scan.pdf's page image too),
`POST …` and `POST …/text` answer 409 `duplicate_document`, and `GET …/{docId}` finds each twin `ready`: the four
files are reported `duplicate`.

## Auth0

Requests to `https://<DIKIGOROS_AUTH0_DOMAIN>`, form-encoded (`application/x-www-form-urlencoded`), each with
redirects refused and a 30-second timeout.

| Request | Form fields | Answer read | Errors handled |
|---|---|---|---|
| `POST /oauth/device/code` | `client_id`; `scope`: `openid offline_access matters:read matters:write account:read`; `audience`: `https://dikigoros.ai/mcp` (`http://localhost:3000/mcp` against a local DIKIGOROS) | `device_code`, `user_code`, `verification_uri`, `verification_uri_complete`, `expires_in`, `interval` | Any refusal, or no answer: "Could not reach the sign-in service (…)"; nothing changes |
| `POST /oauth/token`, device code grant | `grant_type`: `urn:ietf:params:oauth:grant-type:device_code`; `device_code`; `client_id` | `access_token`, `expires_in`, `token_type`, `refresh_token`, `scope` | `authorization_pending`: polled again after `interval` seconds. `slow_down`: `interval` 5 seconds longer from then on. No answer, a timeout or a 5xx: `interval` doubled, polled again. Any other error (`expired_token`, `access_denied`, …) ends the sign-in, and so does `expires_in` running out; the next tool call starts a new one |
| `POST /oauth/token`, refresh token grant | `grant_type`: `refresh_token`; `client_id`; `refresh_token` | As above; a new `refresh_token` replaces the stored one | A 4xx with an OAuth error other than `too_many_requests` (`invalid_grant`, …): the stored refresh token is deleted and a new sign-in starts. No answer, a timeout, a 5xx, a 429, a 4xx without an OAuth error, or an answer without the token fields: "Could not reach the sign-in service (…)"; the refresh token is kept |

The device code is polled in the helper's process, in the background, while the tool's answer carries the link and
the code; a tool call before the approval answers with the same link and code. The access token is refreshed when it
has 60 seconds or less left, and after a 401 from dikigoros.ai.

As the helper assumes it, the tenant allows its client the device authorization grant and refresh tokens, for the API
`https://dikigoros.ai/mcp` with the scopes above: the audience of the remote connector, so that one token serves every
route on the allowlist.
