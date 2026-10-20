import { describe, expect, it } from "vitest";
import type { HelperConfig } from "../config";
import { DeviceFlowError, type FetchLike, pollDeviceToken, refreshAccessToken, requestDeviceCode } from "./device-flow";

const TENANT: Pick<HelperConfig, "auth0Domain" | "auth0ClientId" | "scopes" | "audience"> = {
  auth0Domain: "dikigoros-prod.eu.auth0.com",
  auth0ClientId: "client-123",
  scopes: "openid offline_access matters:read matters:write account:read",
  audience: "https://dikigoros.ai/mcp",
};

/** Auth0's answer to POST /oauth/device/code, every field it sends. */
const DEVICE = {
  device_code: "dc-secret-4f1a",
  user_code: "QTZL-MCBW",
  verification_uri: "https://dikigoros-prod.eu.auth0.com/activate",
  verification_uri_complete: "https://dikigoros-prod.eu.auth0.com/activate?user_code=QTZL-MCBW",
  expires_in: 900,
  interval: 5,
};

/** Auth0's answer to a successful grant on POST /oauth/token, every field it sends. */
const TOKENS = {
  access_token: "at-secret-1",
  id_token: "id-secret-1",
  refresh_token: "rt-secret-2",
  scope: "openid offline_access matters:read matters:write account:read",
  expires_in: 3600,
  token_type: "Bearer",
};

const PENDING = { error: "authorization_pending", error_description: "User has yet to authorize device code." };
const SLOW_DOWN = { error: "slow_down", error_description: "You are polling faster than allowed. Try again in 10 seconds." };

const TOKEN_URL = "https://dikigoros-prod.eu.auth0.com/oauth/token";
const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded" };

/** One device-code grant poll, as the tenant must receive it. */
const POLL_REQUEST = {
  method: "POST",
  url: TOKEN_URL,
  headers: FORM_HEADERS,
  form: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "dc-secret-4f1a", client_id: "client-123" },
};

type Answer = () => Promise<Response>;

function json(status: number, body: unknown): Answer {
  return async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function text(status: number, body: string, contentType: string): Answer {
  return async () => new Response(body, { status, headers: { "Content-Type": contentType } });
}

interface RecordedRequest {
  method: string | undefined;
  url: string;
  headers: Record<string, string>;
  form: Record<string, string>;
}

/** The request's headers, names lower-cased. */
function headerRecord(init: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  new Headers(init).forEach((value, name) => {
    record[name] = value;
  });
  return record;
}

/** A fetch that records each request (its form body decoded) and gives the next canned answer. */
function recordingFetch(...answers: Answer[]): { fetchImpl: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl: FetchLike = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      method: init?.method,
      url: String(input),
      headers: headerRecord(init?.headers),
      form: Object.fromEntries(new URLSearchParams(String(init?.body))),
    });
    const next = answers.shift();
    if (next === undefined) throw new Error(`no answer left for request ${requests.length} (${String(input)})`);
    return next();
  };
  return { fetchImpl, requests };
}

/** A clock that only moves when the code under test sleeps; the sleeps are recorded. */
function fakeClock(start = 1_000_000): { now: () => number; sleep: (ms: number) => Promise<void>; sleeps: number[] } {
  let time = start;
  const sleeps: number[] = [];
  return {
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
    sleeps,
  };
}

/** The DeviceFlowError `promise` rejects with; fails the test when it resolves or rejects otherwise. */
async function refused(promise: Promise<unknown>): Promise<DeviceFlowError> {
  const err = await promise.then(
    () => {
      throw new Error("expected a DeviceFlowError, the call succeeded");
    },
    (reason: unknown) => reason,
  );
  expect(err).toBeInstanceOf(DeviceFlowError);
  return err as DeviceFlowError;
}

describe("requestDeviceCode", () => {
  it("posts client_id, scope and audience form-encoded to /oauth/device/code and returns Auth0's answer", async () => {
    const { fetchImpl, requests } = recordingFetch(json(200, DEVICE));
    expect(await requestDeviceCode(TENANT, fetchImpl)).toEqual(DEVICE);
    expect(requests).toEqual([
      {
        method: "POST",
        url: "https://dikigoros-prod.eu.auth0.com/oauth/device/code",
        headers: FORM_HEADERS,
        form: {
          client_id: "client-123",
          scope: "openid offline_access matters:read matters:write account:read",
          audience: "https://dikigoros.ai/mcp",
        },
      },
    ]);
  });

  it("throws Auth0's refusal as a DeviceFlowError naming its code and description", async () => {
    const description = "Grant type 'urn:ietf:params:oauth:grant-type:device_code' not allowed for the client.";
    const { fetchImpl } = recordingFetch(json(403, { error: "unauthorized_client", error_description: description }));
    const err = await refused(requestDeviceCode(TENANT, fetchImpl));
    expect({ code: err.code, message: err.message }).toEqual({
      code: "unauthorized_client",
      message: `unauthorized_client: ${description}`,
    });
  });
});

describe("pollDeviceToken", () => {
  it("polls at once, waits the interval after authorization_pending and five seconds more after slow_down", async () => {
    const clock = fakeClock();
    const { fetchImpl, requests } = recordingFetch(json(403, PENDING), json(429, SLOW_DOWN), json(200, TOKENS));
    expect(await pollDeviceToken(TENANT, DEVICE, { fetchImpl, ...clock })).toEqual(TOKENS);
    expect(clock.sleeps).toEqual([5000, 10000]);
    expect(requests).toEqual([POLL_REQUEST, POLL_REQUEST, POLL_REQUEST]);
  });

  it("keeps every slow_down increase for the rest of the poll", async () => {
    const clock = fakeClock();
    const { fetchImpl } = recordingFetch(json(429, SLOW_DOWN), json(429, SLOW_DOWN), json(403, PENDING), json(200, TOKENS));
    expect(await pollDeviceToken(TENANT, DEVICE, { fetchImpl, ...clock })).toEqual(TOKENS);
    expect(clock.sleeps).toEqual([10000, 15000, 15000]);
  });

  it("stops at access_denied with DeviceFlowError(access_denied), carrying Auth0's description", async () => {
    const clock = fakeClock();
    const description = "User cancelled the confirmation prompt or consent page; the code is no longer valid.";
    const { fetchImpl, requests } = recordingFetch(json(403, { error: "access_denied", error_description: description }));
    const err = await refused(pollDeviceToken(TENANT, DEVICE, { fetchImpl, ...clock }));
    expect({ code: err.code, message: err.message }).toEqual({ code: "access_denied", message: `access_denied: ${description}` });
    expect(requests).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
  });

  it.each(["expired_token", "invalid_grant", "unauthorized_client"])("stops at %s, with the code alone when Auth0 gives no description", async (error) => {
    const clock = fakeClock();
    const { fetchImpl, requests } = recordingFetch(json(403, { error }));
    const err = await refused(pollDeviceToken(TENANT, DEVICE, { fetchImpl, ...clock }));
    expect({ code: err.code, message: err.message }).toEqual({ code: error, message: error });
    expect(requests).toHaveLength(1);
  });

  it("gives up with expired_token, without another request, once now() is past start + expires_in", async () => {
    const clock = fakeClock();
    const device = { ...DEVICE, expires_in: 10 };
    // Polls at start, +5 s and +10 s (not yet past the deadline); at +15 s it is past, and the
    // success still queued is never asked for.
    const { fetchImpl, requests } = recordingFetch(json(403, PENDING), json(403, PENDING), json(403, PENDING), json(200, TOKENS));
    const err = await refused(pollDeviceToken(TENANT, device, { fetchImpl, ...clock }));
    expect({ code: err.code, message: err.message }).toEqual({ code: "expired_token", message: "expired_token" });
    expect(requests).toHaveLength(3);
    expect(clock.sleeps).toEqual([5000, 5000, 5000]);
  });

  it("names a refusal whose body is not JSON by its HTTP status", async () => {
    const clock = fakeClock();
    const { fetchImpl } = recordingFetch(text(502, "<html><body>Bad Gateway</body></html>", "text/html"));
    const err = await refused(pollDeviceToken(TENANT, DEVICE, { fetchImpl, ...clock }));
    expect({ code: err.code, message: err.message }).toEqual({ code: "http_502", message: "http_502" });
  });
});

describe("refreshAccessToken", () => {
  it("posts the refresh_token grant and returns the tokens, a rotated refresh token included", async () => {
    const { fetchImpl, requests } = recordingFetch(json(200, TOKENS));
    expect(await refreshAccessToken(TENANT, "rt-secret-1", fetchImpl)).toEqual(TOKENS);
    expect(requests).toEqual([
      {
        method: "POST",
        url: TOKEN_URL,
        headers: FORM_HEADERS,
        form: { grant_type: "refresh_token", client_id: "client-123", refresh_token: "rt-secret-1" },
      },
    ]);
  });

  it("throws invalid_grant with Auth0's description and nothing of the refresh token", async () => {
    const { fetchImpl } = recordingFetch(json(403, { error: "invalid_grant", error_description: "Unknown or invalid refresh token." }));
    const err = await refused(refreshAccessToken(TENANT, "rt-secret-1", fetchImpl));
    expect({ code: err.code, message: err.message }).toEqual({
      code: "invalid_grant",
      message: "invalid_grant: Unknown or invalid refresh token.",
    });
  });

  it("lets a request that never reached the tenant reject with fetch's own error, not a DeviceFlowError", async () => {
    const offline = new TypeError("fetch failed");
    const { fetchImpl } = recordingFetch(() => Promise.reject(offline));
    await expect(refreshAccessToken(TENANT, "rt-secret-1", fetchImpl)).rejects.toBe(offline);
  });
});

describe("a success answer that is not what the grant returns", () => {
  const calls: Array<[string, (fetchImpl: FetchLike) => Promise<unknown>]> = [
    ["requestDeviceCode", (fetchImpl) => requestDeviceCode(TENANT, fetchImpl)],
    ["pollDeviceToken", (fetchImpl) => pollDeviceToken(TENANT, DEVICE, { fetchImpl, ...fakeClock() })],
    ["refreshAccessToken", (fetchImpl) => refreshAccessToken(TENANT, "rt-secret-1", fetchImpl)],
  ];

  // JSON.parse's own error would quote the body, and with it the token it carries.
  it.each(calls)("%s refuses a truncated body as invalid_response without quoting it", async (_name, call) => {
    const { fetchImpl } = recordingFetch(text(200, '{"access_token":"at-secret-1","device_code":"dc-secret-4f1a",', "application/json"));
    const err = await refused(call(fetchImpl));
    expect({ code: err.code, message: err.message }).toEqual({ code: "invalid_response", message: "invalid_response" });
  });

  it.each(calls)("%s refuses a JSON body missing the fields it needs as invalid_response", async (_name, call) => {
    const { fetchImpl } = recordingFetch(json(200, { token_type: "Bearer", scope: "openid" }));
    const err = await refused(call(fetchImpl));
    expect({ code: err.code, message: err.message }).toEqual({ code: "invalid_response", message: "invalid_response" });
  });
});
