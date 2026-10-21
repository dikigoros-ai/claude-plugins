# Gate 01 — Auth0 Native application for the local upload helper (device grant)

**Operator:** Mike · **Console:** Auth0 dashboard, tenant **`dikigoros-staging`** (`https://manage.auth0.com/`, tenant switcher top left) first; repeat on **`dikigoros-prod`** at launch · **Date opened:** 2026-10-20 · **Opened by:** the PR 5 session (`dikigoros-ai/claude-plugins`, branch `feat/claude-plugins-01-helper`).

## What it blocks

- Every tool call of the helper until the client id exists: the helper answers *"The helper is not configured (DIKIGOROS_AUTH0_CLIENT_ID is empty)."*
- Gate 03 (the marketplace smoke test on Nicolas's machine).
- Nothing in the main app: PR 1's Auth0 API and the post-login Action are shared with the remote connector and already in PR 1's runbook (`docs/runbooks/auth0-mcp-setup.md`, sections 1 and 6). Do that runbook first on the same tenant.

## Why a separate application

The remote connector signs Claude in through OAuth with PKCE (Claude's own client). The local helper runs on the lawyer's machine with no browser of its own, so it uses the **device authorization grant** (RFC 8628): it prints a URL and a user code, the lawyer approves in any browser, the helper polls for the tokens. Auth0 only issues that grant to a **Native** application with the **Device Code** grant type enabled. The client id is public (a native app has no secret) and will be committed in the plugin manifest.

## Steps, in order

### 1. Prerequisite — the API exists (PR 1's runbook, section 1)

Applications → APIs: an API whose **Identifier** is the MCP URL of the environment you are testing against, byte for byte:

| Environment | Identifier | Where the helper points |
|---|---|---|
| local dev against staging | `http://localhost:3000/mcp` | `DIKIGOROS_BASE_URL=http://localhost:3000` |
| production (at launch) | `https://dikigoros.ai/mcp` | the default |

Checks on that API: **Allow Offline Access = on** (the helper needs a refresh token), signing **RS256**, permissions include `matters:read`, `matters:write`, `account:read` (the helper asks for exactly those three plus `openid offline_access`).

### 2. Create the application

Applications → Applications → **Create Application**:

| Field | Value |
|---|---|
| Name | `dikigoros-upload-helper` |
| Application type | **Native** |

Then **Settings** of the new application:

| Field | Value |
|---|---|
| Description | `Local upload helper of the DIKIGOROS Claude plugin (device authorization grant)` |
| Application Login URI | leave empty |
| Allowed Callback URLs | leave empty (the device grant has no callback) |
| Allowed Logout URLs | leave empty |
| Allowed Web Origins | leave empty |
| ID Token Expiration | default |
| Refresh Token Rotation | **Rotation = on**, **Reuse Interval = `30`** seconds (the helper retries a refresh whose answer was lost; without a reuse window Auth0 would revoke the whole token family on that retry) |
| Refresh Token Expiration | Absolute: **on**, `2592000` s (30 days); Inactivity: **on**, `1296000` s (15 days) — a laptop that has not uploaded for a fortnight signs in again |

**Settings → Advanced Settings → Grant Types**: tick **Device Code** and **Refresh Token**; untick everything else (no Implicit, no Authorization Code, no Client Credentials, no Password). Save.

### 3. Connections

On the application's **Connections** tab enable the same connections the web app uses: **Username-Password-Authentication** and **google-oauth2**. (First-party application: no domain-level promotion needed.)

### 4. Tenant settings for the device flow (optional, once per tenant)

Settings → Advanced → **Device Flow User Code Format**: leave the defaults (Base-20 alphabet, mask `****-****`). The helper shows the code as Auth0 formats it.

### 5. The post-login Action covers this audience (PR 1's runbook, section 6)

Actions → Library → `add-mcp-claims` → Secrets → `MCP_AUDIENCE` must contain the API identifier of step 1 (comma-separated with the others). The helper's access tokens then carry `https://dikigoros.ai/email` and `https://dikigoros.ai/email_verified`, which the server needs to resolve the user with no `/userinfo` round trip — the same tokens the remote connector gets.

### 6. Record the client id

Copy the application's **Client ID** (Settings, top of the page). The manifest carries no environment any more (a manifest value would override the shell for the staging smoke test); the value lives in this repository's `src/config.ts`:

| Where | Key | Value |
|---|---|---|
| `src/config.ts` → `DEFAULT_AUTH0_CLIENT_ID` | `"https://dikigoros.ai"` | the **production** application's Client ID (at launch) |
| `src/config.ts` → `DEFAULT_AUTH0_CLIENT_ID` | `"http://localhost:3000"` | the **staging** application's Client ID (optional; gate 03 can also export `DIKIGOROS_AUTH0_CLIENT_ID` in the shell instead) |
| `src/config.ts` → `DEFAULT_AUTH0_DOMAIN` | per origin | already `dikigoros-prod.eu.auth0.com` / `dikigoros-staging.eu.auth0.com`; change the production one to `auth.dikigoros.ai` only once that custom domain is what the app's `AUTH0_DOMAIN` uses (it must equal the token issuer the server verifies) |

Then `npm run build`, `npm run check`, and commit the source and the rebuilt `plugins/` output together (a verified commit through the API; the client id is public information). `DIKIGOROS_AUTH0_CLIENT_ID` / `DIKIGOROS_AUTH0_DOMAIN` in the environment override these defaults.

## The check

From any shell (no secrets involved; `<client-id>` and the identifier are public):

```bash
curl -s -X POST "https://dikigoros-staging.eu.auth0.com/oauth/device/code" \
  -H "content-type: application/x-www-form-urlencoded" \
  -d "client_id=<client-id>&scope=openid%20offline_access%20matters:read%20matters:write%20account:read&audience=http://localhost:3000/mcp"
```

**Passed** looks like a JSON object with `device_code`, `user_code` (e.g. `WDJB-MJHT`), `verification_uri`, `verification_uri_complete`, `expires_in` (900) and `interval` (5). Then open `verification_uri_complete` in a browser, sign in as a Firm test account and approve: the page says the device is connected. Do not poll the token endpoint by hand; the helper does that (gate 03 proves the whole flow).

**Failed** looks like `{"error":"unauthorized_client","error_description":"Grant type 'urn:ietf:params:oauth:grant-type:device_code' not allowed for the client."}` (step 2's grant types) or `{"error":"access_denied","error_description":"Service not found: …"}` (step 1's identifier).

## At launch

Repeat steps 2–6 on `dikigoros-prod` with the identifier `https://dikigoros.ai/mcp`, and put that application's Client ID in `src/config.ts` (`DEFAULT_AUTH0_CLIENT_ID["https://dikigoros.ai"]`), rebuild, and commit before the release that lawyers install.
