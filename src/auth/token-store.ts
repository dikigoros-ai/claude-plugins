// Where the Auth0 refresh token lives between runs: the OS keychain through @napi-rs/keyring, or,
// when no keychain can be reached, this process's memory (the lawyer then signs in again next run).
// Nothing here logs, and no error raised here carries a secret.

/** The keychain service the helper's entries are filed under; each account is a base URL. */
export const KEYRING_SERVICE = "dikigoros-upload-helper";

export interface TokenStore {
  readonly kind: "keyring" | "memory";
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
}

/** The part of @napi-rs/keyring's synchronous `Entry` the store uses. */
export interface KeyringEntryLike {
  /** null when the entry does not exist. */
  getPassword(): string | null;
  setPassword(password: string): void;
  /** false when there was nothing to delete. */
  deletePassword(): boolean;
}

/** The loaded @napi-rs/keyring module, as far as the store needs it. */
export interface KeyringBinding {
  Entry: new (service: string, account: string) => KeyringEntryLike;
}

/** Secrets kept for the life of this process only. */
export class MemoryTokenStore implements TokenStore {
  readonly kind = "memory";
  private readonly secrets = new Map<string, string>();

  async get(account: string): Promise<string | null> {
    return this.secrets.get(account) ?? null;
  }

  async set(account: string, secret: string): Promise<void> {
    this.secrets.set(account, secret);
  }

  async delete(account: string): Promise<void> {
    this.secrets.delete(account);
  }
}

/** The OS keychain: one entry per account under `service`. Keychain failures reject. */
export class KeyringTokenStore implements TokenStore {
  readonly kind = "keyring";
  private readonly binding: KeyringBinding;
  private readonly service: string;

  constructor(binding: KeyringBinding, service = KEYRING_SERVICE) {
    this.binding = binding;
    this.service = service;
  }

  async get(account: string): Promise<string | null> {
    return this.entry(account).getPassword();
  }

  async set(account: string, secret: string): Promise<void> {
    this.entry(account).setPassword(secret);
  }

  /** Resolves whether or not the account held anything. */
  async delete(account: string): Promise<void> {
    this.entry(account).deletePassword();
  }

  private entry(account: string): KeyringEntryLike {
    return new this.binding.Entry(this.service, account);
  }
}

/** The account the probe reads; nothing is ever stored under it. */
const PROBE_ACCOUNT = "__probe__";

/**
 * The keychain store when `loadBinding` resolves and reading an entry through it does not throw;
 * otherwise a memory store and a warning for the lawyer. The warning's reason is the error's
 * message alone: never its stack, never a value thrown in place of an Error.
 */
export async function createTokenStore(
  loadBinding: () => Promise<KeyringBinding>,
): Promise<{ store: TokenStore; warning: string | null }> {
  try {
    const binding = await loadBinding();
    new binding.Entry(KEYRING_SERVICE, PROBE_ACCOUNT).getPassword();
    return { store: new KeyringTokenStore(binding), warning: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown error";
    return {
      store: new MemoryTokenStore(),
      warning: `The OS keychain is not available on this machine (${reason}); the sign-in is kept in memory for this session only.`,
    };
  }
}
