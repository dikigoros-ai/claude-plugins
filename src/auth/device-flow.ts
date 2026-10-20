// The OAuth 2.0 device authorization grant (RFC 8628) against the Auth0 tenant, and the
// refresh-token grant that renews its access token. Every request goes through the fetch it is
// given. No token or code value is ever put in an error: a DeviceFlowError's message is the error
// code and, when Auth0 sends one, its error_description, nothing else.

import type { HelperConfig } from "../config";

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type: string;
}

/**
 * A grant the tenant refused or could not complete. `code` is Auth0's `error`, `http_<status>` for
 * a refusal without one, `invalid_response` for a success answer the grant cannot use, or
 * `expired_token` when the device code ran out before the lawyer approved it.
 */
export class DeviceFlowError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export type FetchLike = typeof fetch;

type Tenant = Pick<HelperConfig, "auth0Domain" | "auth0ClientId">;

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** RFC 8628 §3.5: each slow_down adds five seconds to the interval, for every later poll. */
const SLOW_DOWN_SECONDS = 5;

/** Starts a sign-in: the device code the poll uses, and the user code and URL for the lawyer. */
export async function requestDeviceCode(
  cfg: Pick<HelperConfig, "auth0Domain" | "auth0ClientId" | "scopes" | "audience">,
  fetchImpl: FetchLike,
): Promise<DeviceCodeResponse> {
  const answer = await postForm(
    cfg,
    "/oauth/device/code",
    { client_id: cfg.auth0ClientId, scope: cfg.scopes, audience: cfg.audience },
    fetchImpl,
  );
  if (!answer.ok) throw refusal(answer);
  if (!isDeviceCodeResponse(answer.body)) throw invalidResponse();
  return answer.body;
}

/**
 * Polls the token endpoint until the lawyer approves the device code: at once, then `interval`
 * seconds after each authorization_pending, five seconds more for good after each slow_down. Any
 * other refusal ends the poll, and so does `now()` passing the device code's expiry.
 */
export async function pollDeviceToken(
  cfg: Tenant,
  device: DeviceCodeResponse,
  deps: { fetchImpl: FetchLike; sleep: (ms: number) => Promise<void>; now: () => number },
): Promise<TokenResponse> {
  const deadline = deps.now() + device.expires_in * 1000;
  let interval = device.interval;
  for (;;) {
    if (deps.now() > deadline) throw new DeviceFlowError("expired_token", "expired_token");
    const answer = await postForm(
      cfg,
      "/oauth/token",
      { grant_type: DEVICE_CODE_GRANT, device_code: device.device_code, client_id: cfg.auth0ClientId },
      deps.fetchImpl,
    );
    if (answer.ok) return tokenResponse(answer.body);
    const err = refusal(answer);
    if (err.code === "slow_down") interval += SLOW_DOWN_SECONDS;
    else if (err.code !== "authorization_pending") throw err;
    await deps.sleep(interval * 1000);
  }
}

/** A new access token for `refreshToken`; the answer carries a new refresh token when Auth0 rotates it. */
export async function refreshAccessToken(cfg: Tenant, refreshToken: string, fetchImpl: FetchLike): Promise<TokenResponse> {
  const answer = await postForm(
    cfg,
    "/oauth/token",
    { grant_type: "refresh_token", client_id: cfg.auth0ClientId, refresh_token: refreshToken },
    fetchImpl,
  );
  if (!answer.ok) throw refusal(answer);
  return tokenResponse(answer.body);
}

interface Answer {
  ok: boolean;
  status: number;
  /** The parsed JSON body; undefined when the body is not JSON. */
  body: unknown;
}

/** POSTs `form` form-encoded to the tenant. A request that never reaches it rejects with fetch's own error. */
async function postForm(
  cfg: Pick<HelperConfig, "auth0Domain">,
  path: string,
  form: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<Answer> {
  const res = await fetchImpl(`https://${cfg.auth0Domain}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  return { ok: res.ok, status: res.status, body: await jsonBody(res) };
}

/** The body as JSON, or undefined. The parser's error is dropped: its message quotes the body. */
async function jsonBody(res: Response): Promise<unknown> {
  try {
    return JSON.parse(await res.text());
  } catch {
    return undefined;
  }
}

/** The DeviceFlowError for a refusal: Auth0's error code (else http_<status>) and its description. */
function refusal({ status, body }: Answer): DeviceFlowError {
  const fields = isRecord(body) ? body : {};
  const code = typeof fields.error === "string" ? fields.error : `http_${status}`;
  const description = typeof fields.error_description === "string" ? fields.error_description : "";
  return new DeviceFlowError(code, description === "" ? code : `${code}: ${description}`);
}

function invalidResponse(): DeviceFlowError {
  return new DeviceFlowError("invalid_response", "invalid_response");
}

function tokenResponse(body: unknown): TokenResponse {
  if (!isTokenResponse(body)) throw invalidResponse();
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDeviceCodeResponse(body: unknown): body is DeviceCodeResponse {
  return (
    isRecord(body) &&
    typeof body.device_code === "string" &&
    typeof body.user_code === "string" &&
    typeof body.verification_uri === "string" &&
    typeof body.verification_uri_complete === "string" &&
    typeof body.expires_in === "number" &&
    typeof body.interval === "number"
  );
}

function isTokenResponse(body: unknown): body is TokenResponse {
  return (
    isRecord(body) &&
    typeof body.access_token === "string" &&
    typeof body.expires_in === "number" &&
    typeof body.token_type === "string" &&
    (body.refresh_token === undefined || typeof body.refresh_token === "string")
  );
}
