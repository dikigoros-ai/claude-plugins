# Gate 02 — make `dikigoros-ai/claude-plugins` public (and tidy the organisation)

**Operator:** Mike · **Console:** GitHub, organisation `dikigoros-ai` · **Date opened:** 2026-10-20 · **Opened by:** the PR 5 session.

## What it blocks

- Lawyers installing the plugin: `/plugin marketplace add dikigoros-ai/claude-plugins` clones the repository, which only works for a public repository (or for people with a GitHub token that can read it). Until then the marketplace works for members of the organisation only.
- The Claude directory / marketplace listing (a later gate of the main series).

It does **not** block merging PR 5 or the smoke test (gate 03), which members can run from the private repository.

## Before flipping — read the checklist

The repository is designed to contain no know-how (spec §7.6): tool descriptions are operational, the docs are factual, no legal content anywhere. Confirm the last items before it goes public:

| Check | Where | Passed looks like |
|---|---|---|
| No secrets, tokens, connection strings | `git log -p --all` grep for `vercel_blob_rw_`, `AUTH0_CLIENT_SECRET`, `sk_`, `dkgr_live_` | no hits (the session kept every secret out; this is the second look) |
| No people's names or internal identifiers in tracked files | `grep -rn "Mike\|Nicolas\|neon\|gentle-thunder\|team_" --exclude-dir=node_modules --exclude-dir=.git .` | hits only in `docs/runbooks/gates/` (these operator files name you — delete or keep them, your call) |
| Third-party licence notices | `plugins/dikigoros/server/dikigoros-upload.mjs.LEGAL.txt` holds the inline notices only; a generated `THIRD_PARTY_NOTICES` for the ~55 bundled packages (pdf.js Apache-2.0, mammoth BSD-2, MCP SDK MIT, @vercel/blob Apache-2.0, zod MIT, tar ISC, …) is a recorded follow-up | decide: ship the follow-up first, or accept the inline notices for the first public cut |
| The leftover repository from the bootstrap | `dikigoros-ai/claude-plugins-unsigned-bootstrap` (archived; its only commit is an unsigned LICENSE commit made through the REST contents API, which GitHub does not sign — the real repository was re-created so that every commit verifies) | **delete it**: repository → Settings → Danger Zone → Delete this repository (the session's token has no `delete_repo` scope) |

## Steps, in order

1. GitHub → `dikigoros-ai/claude-plugins` → **Settings** → **General** → scroll to **Danger Zone** → **Change repository visibility** → **Change to public** → type the repository name → confirm.
2. **Settings → Branches → Add branch ruleset** (or classic protection) for `main`:

   | Field | Value |
   |---|---|
   | Branch name pattern | `main` |
   | Require a pull request before merging | on, 1 approving review, dismiss stale approvals |
   | Require status checks to pass | on: `Lint, typecheck, build, test` (the CI job in `.github/workflows/ci.yml`) |
   | Require signed commits | on (every commit so far is GitHub-signed through the API) |
   | Allow force pushes | off |

3. **Settings → General → Features**: untick Wikis and Projects if unused; leave Issues on (the README points people at issues for support).
4. Optional, for the marketplace entry's `homepage`: `https://dikigoros.ai/connect` must exist (PR 1 ships the `/connect` skeleton); until then the link 404s harmlessly.

## The check

From a shell with no GitHub login (or an incognito browser):

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://github.com/dikigoros-ai/claude-plugins
```

**Passed:** `200`. Then, on any machine with Claude Code, `claude plugin marketplace add dikigoros-ai/claude-plugins` prints `✔ Successfully added marketplace: dikigoros-ai`, and `claude plugin install dikigoros@dikigoros-ai` installs it.

**Failed:** `404` (still private), or the marketplace add asks for credentials.
