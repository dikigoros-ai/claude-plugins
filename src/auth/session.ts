// The lawyer's DIKIGOROS sign-in for the life of the helper process. The access token is held in
// memory with its expiry; the refresh token is kept in the token store under the base URL. A
// sign-in runs the device authorization grant: beginSignIn hands back the URL and code for the
// lawyer and polls the tenant in the background until the browser side is done. No token or code
// value is ever logged or thrown, and the state lives in #private fields, which util.inspect does
// not print.

import type { HelperConfig } from "../config";
import {
  type DeviceCodeResponse,
  DeviceFlowError,
  type FetchLike,
  pollDeviceToken,
  refreshAccessToken,
  requestDeviceCode,
  type TokenResponse,
} from "./device-flow";
import type { TokenStore } from "./token-store";

/** What the lawyer needs to approve a sign-in in a browser. */
export interface SignInPrompt {
  verificationUriComplete: string;
  verificationUri: string;
  userCode: string;
  expiresInSeconds: number;
}

export type SessionStatus = "signed_out" | "pending" | "signed_in";

export interface AuthSessionDeps {
  config: HelperConfig;
  /** The token store, asked for when a token is first read or written. */
  store: () => Promise<TokenStore>;
  fetchImpl: FetchLike;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  openBrowser: (url: string) => void;
  log: (line: string) => void;
}

/** An access token with no more than this left is refreshed rather than handed out. */
const REFRESH_MARGIN_MS = 60_000;

export class AuthSession {
  readonly #deps: AuthSessionDeps;
  #access: { token: string; expiresAt: number } | null = null;
  #signedIn = false;
  /** A refresh token the store refused to keep, used in place of the stored one for this run. */
  #unsavedRefreshToken: string | null = null;
  /** The sign-in in progress, from its device-code request until its poll ends. */
  #signIn: Promise<SignInPrompt> | null = null;
  /** The refresh in flight, shared by concurrent callers so that a refresh token is spent once. */
  #refreshing: Promise<string | null> | null = null;
  /** Bumped by forgetSession: a refresh begun before then is discarded when it lands. */
  #epoch = 0;

  constructor(deps: AuthSessionDeps) {
    this.#deps = deps;
  }

  /** "pending" while a sign-in is in progress; otherwise whether this process holds a sign-in. */
  status(): SessionStatus {
    if (this.#signIn !== null) return "pending";
    return this.#signedIn ? "signed_in" : "signed_out";
  }

  /**
   * The access token held in memory while more than 60 s of it remain, else a new one from the
   * refresh token. null when no refresh token is held, or when Auth0 refuses the grant (the stored
   * token is then deleted). Rejects on a transient failure (no answer, a timeout, a 5xx, a 429, a
   * success it cannot use), keeping the refresh token and the session as they were: an outage
   * never signs the lawyer out.
   */
  async getAccessToken(): Promise<string | null> {
    const access = this.#access;
    if (access !== null && access.expiresAt - this.#deps.now() > REFRESH_MARGIN_MS) return access.token;
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  /**
   * Starts a sign-in, or hands back the prompt of the one in progress without asking for a second
   * device code. A new sign-in opens the verification URL in the browser when config.openBrowser
   * says so, and polls in the background: on approval the access token is held in memory and the
   * refresh token stored under the base URL.
   */
  beginSignIn(): Promise<SignInPrompt> {
    this.#signIn ??= this.#startSignIn();
    return this.#signIn;
  }

  /** Drops the access token held in memory (the API refused it); the next getAccessToken refreshes. */
  invalidateAccessToken(): void {
    this.#access = null;
  }

  /**
   * Signs out: forgets the tokens held in memory and deletes the stored refresh token. A refresh in
   * flight is discarded when it lands; a sign-in in progress carries on, as only the lawyer's
   * approval in the browser completes it.
   */
  async forgetSession(): Promise<void> {
    const store = await this.#deps.store();
    this.#epoch += 1;
    const deleteFailure = await this.#discard(store);
    if (deleteFailure !== null) this.#deps.log(`Removing the sign-in from the OS keychain failed (${deleteFailure}).`);
  }

  async #refresh(): Promise<string | null> {
    const epoch = this.#epoch;
    const store = await this.#deps.store();
    const refreshToken = this.#unsavedRefreshToken ?? (await store.get(this.#account));
    if (refreshToken === null) {
      this.#signedIn = false;
      return null;
    }
    let tokens: TokenResponse;
    try {
      tokens = await refreshAccessToken(this.#deps.config, refreshToken, this.#deps.fetchImpl);
    } catch (err) {
      if (!refusedByAuth0(err)) throw err; // an outage: the refresh token and the session stay
      const deleteFailure = await this.#discard(store);
      this.#deps.log(
        deleteFailure === null
          ? `The stored sign-in was refused (${reason(err)}) and has been removed.`
          : `The stored sign-in was refused (${reason(err)}); removing it from the OS keychain failed (${deleteFailure}).`,
      );
      return null;
    }
    if (epoch !== this.#epoch) return null;
    return this.#accept(tokens);
  }

  async #startSignIn(): Promise<SignInPrompt> {
    let device: DeviceCodeResponse;
    try {
      device = await requestDeviceCode(this.#deps.config, this.#deps.fetchImpl);
    } catch (err) {
      this.#signIn = null;
      throw err;
    }
    void this.#completeSignIn(device);
    if (this.#deps.config.openBrowser) this.#deps.openBrowser(device.verification_uri_complete);
    return {
      verificationUriComplete: device.verification_uri_complete,
      verificationUri: device.verification_uri,
      userCode: device.user_code,
      expiresInSeconds: device.expires_in,
    };
  }

  /** The background poll of a sign-in; it never rejects, a failure is one log line. */
  async #completeSignIn(device: DeviceCodeResponse): Promise<void> {
    try {
      await this.#accept(await pollDeviceToken(this.#deps.config, device, this.#deps));
    } catch (err) {
      this.#deps.log(`Sign-in did not complete (${reason(err)}).`);
    } finally {
      this.#signIn = null;
    }
  }

  /** Takes the tokens of a completed grant: the access token into memory, a refresh token into the store. */
  async #accept(tokens: TokenResponse): Promise<string> {
    this.#access = { token: tokens.access_token, expiresAt: this.#deps.now() + tokens.expires_in * 1000 };
    this.#signedIn = true;
    if (tokens.refresh_token !== undefined) await this.#saveRefreshToken(tokens.refresh_token);
    return tokens.access_token;
  }

  /** Stores the refresh token; a store that refuses it leaves it in memory for this run, and says so once. */
  async #saveRefreshToken(refreshToken: string): Promise<void> {
    try {
      const store = await this.#deps.store();
      await store.set(this.#account, refreshToken);
      this.#unsavedRefreshToken = null;
    } catch (err) {
      this.#unsavedRefreshToken = refreshToken;
      this.#deps.log(
        `Saving the sign-in to the OS keychain failed (${reason(err)}); it is kept in memory for this session only.`,
      );
    }
  }

  /** Forgets every token, in memory and in the store. Answers why the store's delete failed, or null. */
  async #discard(store: TokenStore): Promise<string | null> {
    this.#access = null;
    this.#signedIn = false;
    this.#unsavedRefreshToken = null;
    try {
      await store.delete(this.#account);
      return null;
    } catch (err) {
      return reason(err);
    }
  }

  /** The token store account: one sign-in per base URL. */
  get #account(): string {
    return this.#deps.config.baseUrl;
  }
}

/**
 * Whether Auth0 refused the grant itself: a 4xx answer carrying an OAuth error other than the rate
 * limit's. Anything else is an outage, after which the same refresh token may still work: no answer,
 * a timeout, a 5xx, a 429, a 4xx with no OAuth error (device-flow names those http_<status>), or a
 * success answer it cannot use.
 */
function refusedByAuth0(err: unknown): boolean {
  return (
    err instanceof DeviceFlowError &&
    err.status >= 400 &&
    err.status < 500 &&
    err.status !== 429 &&
    err.code !== "too_many_requests" &&
    err.code !== `http_${err.status}`
  );
}

/** An error's message, first line only; never a stack, never a value thrown in place of an Error. */
function reason(err: unknown): string {
  return err instanceof Error ? err.message.split(/\r?\n/, 1)[0] : "unknown error";
}
