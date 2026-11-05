# Gate 04 — submit the `dikigoros` plugin to Anthropic's plugin directory

**Who:** Mike (the submission is made from the DIKAI LTD Claude organization). **Console:** the Claude plugin
directory's submission form (from the Claude Teams/Enterprise organization's admin settings; the form's location
moves — follow the current "submit a plugin" link from Anthropic's plugin documentation). **Status:** open.

Our own marketplace (`/plugin marketplace add dikigoros-ai/claude-plugins`) is the install path that works first;
the directory listing is the second stage. This checklist is everything the form is expected to ask, prepared so the
submission is one sitting.

## What it blocks

The plugin appearing in Claude's plugin directory (and so being installable without typing the marketplace name).
Nothing else: the plugin works from our marketplace without it.

## Prerequisites

- [ ] Gate 01 done: the production Auth0 Native application exists and its client id is in `src/config.ts`.
- [ ] Main series gate 09 done: the connector is live at `https://dikigoros.ai/mcp` and `/connect` is open.
- [ ] Gate 03 passed for 0.2.0 (steps 6 and 7), its screenshots kept.
- [ ] 0.2.0 merged to `main` and tagged `v0.2.0`; `claude plugin validate .` passes on the tag.
- [ ] The main app's allowlist fix (`POST /api/matters/[id]/documents/text`) deployed to production.
- [ ] Nicolas's Terms / Privacy wording for the connector and the helper published
  (`docs/legal/2026-10-mcp-connector-terms-privacy-handoff.md` in the main repository).

## The listing

| Field | Value |
|---|---|
| Name | `dikigoros` (display name `dikigoros.ai`) |
| Repository | `https://github.com/dikigoros-ai/claude-plugins` (public, MIT) |
| Marketplace | `dikigoros-ai` at the repository root; plugin source `./plugins/dikigoros` |
| Version | `0.2.0` |
| Category | Legal |
| Homepage | `https://dikigoros.ai/connect` |
| Privacy policy | `https://dikigoros.ai/privacy` |
| Terms | `https://dikigoros.ai/terms` |
| Support contact | the support address shown on `https://dikigoros.ai/contact` (check it before submitting) |

**One line (EN):** Cyprus case law, legislation and your DIKIGOROS matters in Claude, plus a local helper that
sets a case folder up as a matter and uploads its files.

**One line (EL):** Κυπριακή νομολογία, νομοθεσία και οι υποθέσεις σας στο DIKIGOROS μέσα στο Claude, με τοπικό
βοηθό που οργανώνει τον φάκελο μιας υπόθεσης σε υπόθεση και ανεβάζει τα αρχεία της.

**Description (EN):** The plugin connects Claude to DIKIGOROS AI, the Cyprus legal research platform: search and
read Cyprus case law and legislation, and work with your matters. Its local helper, which runs on your computer,
uploads PDF, Word and text files from a folder into a matter: `/dikigoros:init-matter` opens a new matter for a
case folder, shows a picker to choose the files within your plan's limits, and uploads them. Matters and uploads
need a DIKIGOROS Firm plan.

## Data-flow statement (for the form's security/privacy questions)

- The remote connector (`https://dikigoros.ai/mcp`) is reached over OAuth with the lawyer's own DIKIGOROS account.
- The local helper signs in with the Auth0 device flow; its refresh token is kept in the OS keychain, never on disk
  in plain text; no token appears in any tool result or log.
- Listing and scanning a folder reads it on the computer only; nothing about the files is sent until the lawyer
  confirms a selection.
- On confirmation, each file's bytes go from the computer straight to DIKIGOROS's private blob store, never
  through the dikigoros.ai servers; text extraction and the rendering of scanned pages run on the computer; the
  extracted text goes to dikigoros.ai.
- The helper talks only to `https://dikigoros.ai` and its Auth0 tenant (and, on first use, the npm registry for two
  pinned, hash-verified native packages).
- The picker widget makes no network request (its resource declares an empty CSP).
- The only file the helper writes in the lawyer's folder is `.dikigoros/matter.json` (the matter's id, title and
  the uploaded files' names, sizes and hashes).

## Screenshots

From gate 03 step 7.5 and step 6: the picker in English and in Greek, the chat fallback in the Claude Code
terminal, the matter page after the upload. Crop out any client data; use the smoke-test folder only.

## Steps

1. Tick the prerequisites above.
2. Open the submission form, fill the listing and the data-flow answers from this file, attach the screenshots.
3. Record the submission date and any reference here, and set the gate's row in `MIKE-TODO.md` to "submitted".
4. When the review answers, note the outcome; a requested change goes into a new plugin version through
   `docs/release-process.md`.
