# Operator gates — `dikigoros-ai/claude-plugins` (PR 5 of the MCP connector series)

One row per step that only an operator can take. Each links to its runbook; do them in order within a row's "After" column. The main repository keeps the series-wide list (`docs/runbooks/gates/MIKE-TODO.md` there); the controller merges these rows into it.

| # | Gate | Who | Console | After | Blocks | Status |
|---|---|---|---|---|---|---|
| 01 | [Auth0 Native application with the Device Code grant](2026-10-20-01-auth0-native-app-device-grant.md) — staging tenant now, production at launch; client id into `src/config.ts` (`DEFAULT_AUTH0_CLIENT_ID`), then rebuild | Mike | Auth0 dashboard (`dikigoros-staging`, then `dikigoros-prod`) | PR 1's `auth0-mcp-setup.md` sections 1 and 6 on the same tenant | every helper tool call; gate 03 | open |
| 02 | [Make the repository public, protect `main`, delete the archived bootstrap repository](2026-10-20-02-repository-public.md) | Mike | GitHub, org `dikigoros-ai` | PR 5 merged; the THIRD_PARTY_NOTICES follow-up decided | lawyers installing the plugin; the directory listing | done 2026-10-21 (public; ruleset `main`: PR + 1 review, CI check, signed commits, no force-push, admins bypass only through a PR; wiki/projects off) — **left: delete the archived `claude-plugins-unsigned-bootstrap`** (needs the `delete_repo` scope) |
| 03 | [Live pass on Nicolas's Mac: Cowork + Claude Code, a real folder (CCITT-G4 scan, DOCX, TXT)](2026-10-20-03-marketplace-smoke-test.md) | Nicolas (Mike: prerequisites) | Nicolas's Mac + the matter page | gate 01; main app PR 1 + PR 4 deployed where the test runs | calling PR 5 verified end to end; the announcement | open |

Not a gate, but yours: the main series' **PR 4** must add `POST /api/matters/[id]/documents/text` and `PATCH /api/matters/[id]/documents/[docId]` (role/side) to `CONNECTOR_TOKEN_ROUTES` under `matters:write` — `docs/assumed-routes.md` in this repository is the contract the helper assumes.
