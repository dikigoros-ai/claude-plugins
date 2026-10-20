import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { HelperConfig } from "../config";
import type { FetchLike } from "./device-flow";
import { AuthSession } from "./session";
import { type KeyringBinding, KeyringTokenStore, MemoryTokenStore, type TokenStore } from "./token-store";

const ACCOUNT = "https://dikigoros.ai";

const CONFIG: HelperConfig = {
  baseUrl: "https://dikigoros.ai",
  audience: "https://dikigoros.ai/mcp",
  auth0Domain: "dikigoros-prod.eu.auth0.com",
  auth0ClientId: "client-123",
  scopes: "openid offline_access matters:read matters:write account:read",
  dataDir: "/home/lawyer/.dikigoros/helper",
  openBrowser: true,
  nativeDirOverride: null,
};

const DEVICE_CODE_URL = "https://dikigoros-prod.eu.auth0.com/oauth/device/code";
const TOKEN_URL = "https://dikigoros-prod.eu.auth0.com/oauth/token";
const VERIFICATION_URI_COMPLETE = "https://dikigoros-prod.eu.auth0.com/activate?user_code=QTZL-MCBW";

/** The prompt Auth0's device-code answer below becomes. */
const PROMPT = {
  verificationUriComplete: VERIFICATION_URI_COMPLETE,
  verificationUri: "https://dikigoros-prod.eu.auth0.com/activate",
  userCode: "QTZL-MCBW",
  expiresInSeconds: 900,
};

/** Every token, code and device code value handed out below; none may reach a log line. */
const SECRETS = ["dc-secret", "QTZL-MCBW", "at-secret", "rt-secret", "id-secret"];

type Answer = () => Promise<Response>;

function json(status: number, body: unknown): Answer {
  return async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const deviceCode = json(200, {
  device_code: "dc-secret-4f1a",
  user_code: "QTZL-MCBW",
  verification_uri: "https://dikigoros-prod.eu.auth0.com/activate",
  verification_uri_complete: VERIFICATION_URI_COMPLETE,
  expires_in: 900,
  interval: 5,
});
const pending = json(403, { error: "authorization_pending", error_description: "User has yet to authorize device code." });
const invalidGrant = json(403, { error: "invalid_grant", error_description: "Unknown or invalid refresh token." });

/** A successful grant: access token at-secret-<n> for an hour, and a refresh token when one is given. */
function tokens(n: number, refreshToken?: string): Answer {
  return json(200, {
    access_token: `at-secret-${n}`,
    id_token: `id-secret-${n}`,
    ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
    scope: "openid offline_access matters:read matters:write account:read",
    expires_in: 3600,
    token_type: "Bearer",
  });
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
function recordingFetch(answers: Answer[]): { fetchImpl: FetchLike; requests: RecordedRequest[] } {
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

/** A sleep that never ends: the background poll stays pending after its first answer. */
const parked = (): Promise<void> => new Promise(() => {});

function setup(options: {
  answers: Answer[];
  store?: TokenStore;
  config?: Partial<HelperConfig>;
  sleep?: (ms: number) => Promise<void>;
}) {
  const { fetchImpl, requests } = recordingFetch(options.answers);
  const store = options.store ?? new MemoryTokenStore();
  let time = 1_000_000;
  const sleeps: number[] = [];
  const opened: string[] = [];
  const logs: string[] = [];
  const session = new AuthSession({
    config: { ...CONFIG, ...options.config },
    store: async () => store,
    fetchImpl,
    sleep:
      options.sleep ??
      (async (ms) => {
        sleeps.push(ms);
        time += ms;
      }),
    now: () => time,
    openBrowser: (url) => {
      opened.push(url);
    },
    log: (line) => {
      logs.push(line);
    },
  });
  const advance = (ms: number) => {
    time += ms;
  };
  return { session, store, requests, sleeps, opened, logs, advance };
}

/** A memory store that already holds `refreshToken` for `account`. */
async function storeHolding(refreshToken: string, account = ACCOUNT): Promise<MemoryTokenStore> {
  const store = new MemoryTokenStore();
  await store.set(account, refreshToken);
  return store;
}

/** The OS keychain through a binding that reads nothing and refuses every write and delete. */
function lockedKeychain(): TokenStore {
  const error = new Error("Platform secure storage failure: User interaction is not allowed.\n    at Entry.setPassword (keyring.node)");
  const binding: KeyringBinding = {
    Entry: class {
      getPassword(): string | null {
        return null;
      }
      setPassword(): void {
        throw error;
      }
      deletePassword(): boolean {
        throw error;
      }
    },
  };
  return new KeyringTokenStore(binding);
}

describe("beginSignIn", () => {
  it("returns the prompt, opens verification_uri_complete once and asks for no second device code while pending", async () => {
    const { session, requests, opened } = setup({ answers: [deviceCode, pending], sleep: parked });
    const prompt = await session.beginSignIn();
    expect(prompt).toEqual(PROMPT);
    expect(session.status()).toBe("pending");
    expect(await session.beginSignIn()).toBe(prompt);
    expect(requests.filter((r) => r.url === DEVICE_CODE_URL)).toHaveLength(1);
    expect(opened).toEqual([VERIFICATION_URI_COMPLETE]);
  });

  it("shares one device-code request between concurrent calls", async () => {
    const { session, requests } = setup({ answers: [deviceCode, pending], sleep: parked });
    const [first, second] = await Promise.all([session.beginSignIn(), session.beginSignIn()]);
    expect(second).toBe(first);
    expect(requests.filter((r) => r.url === DEVICE_CODE_URL)).toHaveLength(1);
  });

  it("does not open the browser when config.openBrowser is false", async () => {
    const { session, opened } = setup({ answers: [deviceCode, pending], sleep: parked, config: { openBrowser: false } });
    expect(await session.beginSignIn()).toEqual(PROMPT);
    expect(opened).toEqual([]);
  });

  it("signs in when the background poll succeeds: signed_in, the refresh token stored under the base URL", async () => {
    const { session, store, requests, sleeps, logs } = setup({ answers: [deviceCode, pending, tokens(1, "rt-secret-1")] });
    await session.beginSignIn();
    await vi.waitFor(() => expect(session.status()).toBe("signed_in"));
    expect(await store.get(ACCOUNT)).toBe("rt-secret-1");
    expect(await session.getAccessToken()).toBe("at-secret-1"); // from memory: no refresh request
    expect(requests.map((r) => r.url)).toEqual([DEVICE_CODE_URL, TOKEN_URL, TOKEN_URL]);
    expect(requests[1].form).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "dc-secret-4f1a",
      client_id: "client-123",
    });
    expect(sleeps).toEqual([5000]);
    expect(logs).toEqual([]);
  });

  it("ends a sign-in refused in the browser: signed_out, one log line, and a new device code next time", async () => {
    const description = "User cancelled the confirmation prompt or consent page; the code is no longer valid.";
    const refusal = json(403, { error: "access_denied", error_description: description });
    const { session, store, requests, logs } = setup({ answers: [deviceCode, refusal, deviceCode, pending], sleep: parked });
    await session.beginSignIn();
    await vi.waitFor(() => expect(session.status()).toBe("signed_out"));
    expect(logs).toEqual([`Sign-in did not complete (access_denied: ${description}).`]);
    expect(await store.get(ACCOUNT)).toBeNull();
    expect(await session.beginSignIn()).toEqual(PROMPT);
    expect(requests.filter((r) => r.url === DEVICE_CODE_URL)).toHaveLength(2);
  });

  it("rejects when the device code is refused, and asks again on the next call", async () => {
    const description = "Grant type 'urn:ietf:params:oauth:grant-type:device_code' not allowed for the client.";
    const refusal = json(403, { error: "unauthorized_client", error_description: description });
    const { session, requests, opened } = setup({ answers: [refusal, deviceCode, pending], sleep: parked });
    await expect(session.beginSignIn()).rejects.toThrow(`unauthorized_client: ${description}`);
    expect(session.status()).toBe("signed_out");
    expect(opened).toEqual([]);
    expect(await session.beginSignIn()).toEqual(PROMPT);
    expect(requests.filter((r) => r.url === DEVICE_CODE_URL)).toHaveLength(2);
  });
});

describe("getAccessToken", () => {
  it("answers null, without a request, when no refresh token is stored", async () => {
    const { session, requests } = setup({ answers: [] });
    expect(await session.getAccessToken()).toBeNull();
    expect(session.status()).toBe("signed_out");
    expect(requests).toEqual([]);
  });

  it("refreshes from the stored refresh token and serves the result from memory while more than 60 s remain", async () => {
    const store = await storeHolding("rt-secret-1");
    const { session, requests, advance } = setup({ answers: [tokens(1), tokens(2)], store });
    expect(await session.getAccessToken()).toBe("at-secret-1");
    expect(session.status()).toBe("signed_in");
    expect(requests).toEqual([
      {
        method: "POST",
        url: TOKEN_URL,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        form: { grant_type: "refresh_token", client_id: "client-123", refresh_token: "rt-secret-1" },
      },
    ]);
    advance(3_539_000); // 61 s of the hour left
    expect(await session.getAccessToken()).toBe("at-secret-1");
    expect(requests).toHaveLength(1);
    advance(1_000); // 60 s left
    expect(await session.getAccessToken()).toBe("at-secret-2");
    expect(requests.map((r) => r.form.refresh_token)).toEqual(["rt-secret-1", "rt-secret-1"]);
    expect(await store.get(ACCOUNT)).toBe("rt-secret-1"); // the answers rotated nothing
  });

  it("stores a rotated refresh token under the base URL and refreshes with it after invalidateAccessToken", async () => {
    const local = "http://localhost:3000";
    const store = await storeHolding("rt-secret-1", local);
    const { session, requests } = setup({
      answers: [tokens(1, "rt-secret-2"), tokens(2, "rt-secret-3")],
      store,
      config: { baseUrl: local, audience: `${local}/mcp` },
    });
    expect(await session.getAccessToken()).toBe("at-secret-1");
    expect(await store.get(local)).toBe("rt-secret-2");
    session.invalidateAccessToken();
    expect(session.status()).toBe("signed_in");
    expect(await session.getAccessToken()).toBe("at-secret-2");
    expect(requests.map((r) => r.form.refresh_token)).toEqual(["rt-secret-1", "rt-secret-2"]);
    expect(await store.get(local)).toBe("rt-secret-3");
  });

  it("answers null, deletes the stored token and logs once when the refresh is refused with 403 invalid_grant", async () => {
    const store = await storeHolding("rt-secret-1");
    const { session, requests, logs, advance } = setup({ answers: [tokens(1), invalidGrant], store });
    expect(await session.getAccessToken()).toBe("at-secret-1");
    advance(3_600_000);
    expect(await session.getAccessToken()).toBeNull();
    expect(await store.get(ACCOUNT)).toBeNull();
    expect(session.status()).toBe("signed_out");
    expect(logs).toEqual(["The stored sign-in was refused (invalid_grant: Unknown or invalid refresh token.) and has been removed."]);
    expect(await session.getAccessToken()).toBeNull();
    expect(requests).toHaveLength(2);
  });

  it("answers null once a sign-in that brought no refresh token runs out of access token", async () => {
    const { session, store, requests, advance } = setup({ answers: [deviceCode, tokens(1)] });
    await session.beginSignIn();
    await vi.waitFor(() => expect(session.status()).toBe("signed_in"));
    expect(await store.get(ACCOUNT)).toBeNull();
    expect(await session.getAccessToken()).toBe("at-secret-1");
    advance(3_600_000);
    expect(await session.getAccessToken()).toBeNull();
    expect(session.status()).toBe("signed_out");
    expect(requests.map((r) => r.url)).toEqual([DEVICE_CODE_URL, TOKEN_URL]);
  });

  it("shares one refresh between concurrent callers, so the refresh token is spent once", async () => {
    const store = await storeHolding("rt-secret-1");
    const { session, requests } = setup({ answers: [tokens(1, "rt-secret-2")], store });
    expect(await Promise.all([session.getAccessToken(), session.getAccessToken()])).toEqual(["at-secret-1", "at-secret-1"]);
    expect(requests).toHaveLength(1);
  });

  it("rejects with fetch's error and keeps the stored token when the tenant cannot be reached", async () => {
    const store = await storeHolding("rt-secret-1");
    const offline = new TypeError("fetch failed");
    const { session, logs } = setup({ answers: [() => Promise.reject(offline), tokens(1)], store });
    await expect(session.getAccessToken()).rejects.toBe(offline);
    expect(await store.get(ACCOUNT)).toBe("rt-secret-1");
    expect(logs).toEqual([]);
    expect(await session.getAccessToken()).toBe("at-secret-1"); // the next call tries again
  });
});

describe("a keychain that refuses the write", () => {
  it("still signs in for this run, logs the error's first line once, and refreshes from memory", async () => {
    const { session, requests, logs, advance } = setup({
      answers: [deviceCode, tokens(1, "rt-secret-1"), tokens(2)],
      store: lockedKeychain(),
    });
    await session.beginSignIn();
    await vi.waitFor(() => expect(session.status()).toBe("signed_in"));
    expect(await session.getAccessToken()).toBe("at-secret-1");
    advance(3_600_000);
    expect(await session.getAccessToken()).toBe("at-secret-2");
    expect(requests.at(-1)?.form).toEqual({ grant_type: "refresh_token", client_id: "client-123", refresh_token: "rt-secret-1" });
    expect(logs).toEqual([
      "Saving the sign-in to the OS keychain failed (Platform secure storage failure: User interaction is not allowed.); it is kept in memory for this session only.",
    ]);
  });

  it("answers null when the refresh token held in memory is refused, though the keychain refuses the delete too", async () => {
    const { session, requests, logs, advance } = setup({
      answers: [deviceCode, tokens(1, "rt-secret-1"), invalidGrant],
      store: lockedKeychain(),
    });
    await session.beginSignIn();
    await vi.waitFor(() => expect(session.status()).toBe("signed_in"));
    advance(3_600_000);
    expect(await session.getAccessToken()).toBeNull();
    expect(session.status()).toBe("signed_out");
    expect(logs).toEqual([
      "Saving the sign-in to the OS keychain failed (Platform secure storage failure: User interaction is not allowed.); it is kept in memory for this session only.",
      "Removing the sign-in from the OS keychain failed (Platform secure storage failure: User interaction is not allowed.).",
      "The stored sign-in was refused (invalid_grant: Unknown or invalid refresh token.) and has been removed.",
    ]);
    expect(await session.getAccessToken()).toBeNull(); // the refused token is gone from memory too
    expect(requests).toHaveLength(3);
  });

  it("never puts a value thrown in place of an Error into the log line", async () => {
    const store: TokenStore = {
      kind: "keyring",
      get: async () => null,
      set: () => Promise.reject("rt-secret-1"),
      delete: async () => {},
    };
    const { session, logs } = setup({ answers: [deviceCode, tokens(1, "rt-secret-1")], store });
    await session.beginSignIn();
    await vi.waitFor(() => expect(session.status()).toBe("signed_in"));
    expect(logs).toEqual(["Saving the sign-in to the OS keychain failed (unknown error); it is kept in memory for this session only."]);
  });
});

describe("forgetSession", () => {
  it("drops the tokens and deletes the stored refresh token", async () => {
    const store = await storeHolding("rt-secret-1");
    const { session, requests } = setup({ answers: [tokens(1)], store });
    expect(await session.getAccessToken()).toBe("at-secret-1");
    await session.forgetSession();
    expect(session.status()).toBe("signed_out");
    expect(await store.get(ACCOUNT)).toBeNull();
    expect(await session.getAccessToken()).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it("discards a refresh that was in flight when the session was forgotten", async () => {
    const store = await storeHolding("rt-secret-1");
    let release: () => void = () => {};
    const held: Answer = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }).then(tokens(1, "rt-secret-2"));
    const { session, requests } = setup({ answers: [held], store });
    const refreshing = session.getAccessToken();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await session.forgetSession();
    release();
    expect(await refreshing).toBeNull();
    expect(await store.get(ACCOUNT)).toBeNull();
    expect(session.status()).toBe("signed_out");
  });
});

it("keeps every token and code out of its log lines and out of util.inspect", async () => {
  const description = "User cancelled the confirmation prompt or consent page; the code is no longer valid.";
  const { session, logs, advance } = setup({
    answers: [deviceCode, tokens(1, "rt-secret-1"), invalidGrant, deviceCode, json(403, { error: "access_denied", error_description: description })],
    store: lockedKeychain(),
  });
  await session.beginSignIn();
  await vi.waitFor(() => expect(session.status()).toBe("signed_in"));
  const inspected = inspect(session, { showHidden: true, depth: Infinity });
  advance(3_600_000);
  expect(await session.getAccessToken()).toBeNull(); // the refresh token held in memory is refused
  await session.beginSignIn();
  await vi.waitFor(() => expect(session.status()).toBe("signed_out"));
  expect(logs).toHaveLength(4); // keychain write, keychain delete, refused refresh, refused sign-in
  for (const shown of [...logs, inspected]) {
    for (const secret of SECRETS) expect(shown).not.toContain(secret);
  }
});
