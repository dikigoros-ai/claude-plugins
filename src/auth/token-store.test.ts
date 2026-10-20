import { inspect } from "node:util";
import { expect, it } from "vitest";
import {
  createTokenStore,
  type KeyringBinding,
  type KeyringEntryLike,
  KeyringTokenStore,
  MemoryTokenStore,
  type TokenStore,
} from "./token-store";

const ACCOUNT = "https://dikigoros.ai";
const OTHER_ACCOUNT = "http://localhost:3000";

/**
 * A stand-in for @napi-rs/keyring: its synchronous Entry over a Map keyed "service | account". As
 * with the real binding, getPassword answers null and deletePassword false for a missing entry.
 * `opened` records the "service | account" of every Entry constructed.
 */
function fakeKeyring(): { binding: KeyringBinding; vault: Map<string, string>; opened: string[] } {
  const vault = new Map<string, string>();
  const opened: string[] = [];
  class Entry implements KeyringEntryLike {
    readonly #slot: string;
    constructor(service: string, account: string) {
      this.#slot = `${service} | ${account}`;
      opened.push(this.#slot);
    }
    getPassword(): string | null {
      return vault.get(this.#slot) ?? null;
    }
    setPassword(password: string): void {
      vault.set(this.#slot, password);
    }
    deletePassword(): boolean {
      return vault.delete(this.#slot);
    }
  }
  return { binding: { Entry }, vault, opened };
}

/** A binding that loads but whose every keychain call throws, as on Linux without a Secret Service. */
function unreachableKeyring(error: Error): KeyringBinding {
  return {
    Entry: class implements KeyringEntryLike {
      getPassword(): string | null {
        throw error;
      }
      setPassword(): void {
        throw error;
      }
      deletePassword(): boolean {
        throw error;
      }
    },
  };
}

it("MemoryTokenStore keeps one secret per account until it is deleted", async () => {
  const store = new MemoryTokenStore();
  expect(store.kind).toBe("memory");
  expect(await store.get(ACCOUNT)).toBeNull();
  await store.set(ACCOUNT, "rt-1");
  await store.set(OTHER_ACCOUNT, "rt-local");
  await store.set(ACCOUNT, "rt-2"); // a rotated refresh token replaces the old one
  expect(await store.get(ACCOUNT)).toBe("rt-2");
  await store.delete(ACCOUNT);
  expect(await store.get(ACCOUNT)).toBeNull();
  expect(await store.get(OTHER_ACCOUNT)).toBe("rt-local");
});

it("MemoryTokenStore keeps its secrets where util.inspect does not show them", async () => {
  const store = new MemoryTokenStore();
  await store.set(ACCOUNT, "rt-secret-1");
  expect(inspect(store, { showHidden: true, depth: Infinity })).not.toContain("rt-secret-1");
  expect(JSON.stringify(store)).not.toContain("rt-secret-1");
});

it("KeyringTokenStore files each account under the dikigoros-upload-helper service", async () => {
  const { binding, vault } = fakeKeyring();
  const store = new KeyringTokenStore(binding);
  expect(store.kind).toBe("keyring");
  expect(await store.get(ACCOUNT)).toBeNull();
  await store.set(ACCOUNT, "rt-1");
  await store.set(OTHER_ACCOUNT, "rt-local");
  await store.set(ACCOUNT, "rt-2");
  expect(Object.fromEntries(vault)).toEqual({
    "dikigoros-upload-helper | https://dikigoros.ai": "rt-2",
    "dikigoros-upload-helper | http://localhost:3000": "rt-local",
  });
  expect(await store.get(ACCOUNT)).toBe("rt-2");
  await store.delete(ACCOUNT);
  expect(await store.get(ACCOUNT)).toBeNull();
  expect(Object.fromEntries(vault)).toEqual({ "dikigoros-upload-helper | http://localhost:3000": "rt-local" });
});

it("KeyringTokenStore files under the service it is given", async () => {
  const { binding, vault } = fakeKeyring();
  const store = new KeyringTokenStore(binding, "dikigoros-test");
  await store.set(ACCOUNT, "rt-1");
  expect(Object.fromEntries(vault)).toEqual({ "dikigoros-test | https://dikigoros.ai": "rt-1" });
  expect(await store.get(ACCOUNT)).toBe("rt-1");
});

it.each([
  { kind: "memory", make: (): TokenStore => new MemoryTokenStore() },
  { kind: "keyring", make: (): TokenStore => new KeyringTokenStore(fakeKeyring().binding) },
])("$kind: deleting an account that holds nothing resolves", async ({ make }) => {
  await expect(make().delete(ACCOUNT)).resolves.toBeUndefined();
});

it("createTokenStore picks the keychain when the binding loads and the probe can read", async () => {
  const { binding, vault, opened } = fakeKeyring();
  const { store, warning } = await createTokenStore(async () => binding);
  expect(warning).toBeNull();
  expect(store.kind).toBe("keyring");
  expect(opened).toEqual(["dikigoros-upload-helper | __probe__"]);
  expect(vault.size).toBe(0); // the probe only reads
  await store.set(ACCOUNT, "rt-1");
  expect(Object.fromEntries(vault)).toEqual({ "dikigoros-upload-helper | https://dikigoros.ai": "rt-1" });
});

it("createTokenStore falls back to memory, with the warning, when the binding does not load", async () => {
  const { store, warning } = await createTokenStore(async () => {
    throw new Error("Cannot find module '@napi-rs/keyring'");
  });
  expect(store.kind).toBe("memory");
  expect(warning).toBe(
    "The OS keychain is not available on this machine (Cannot find module '@napi-rs/keyring'); the sign-in is kept in memory for this session only.",
  );
  await store.set(ACCOUNT, "rt-1");
  expect(await store.get(ACCOUNT)).toBe("rt-1");
});

it("createTokenStore falls back to memory, with the warning, when the probe throws", async () => {
  const error = new Error("Platform secure storage failure: no Secret Service is running");
  const { store, warning } = await createTokenStore(async () => unreachableKeyring(error));
  expect(store.kind).toBe("memory");
  expect(warning).toBe(
    "The OS keychain is not available on this machine (Platform secure storage failure: no Secret Service is running); the sign-in is kept in memory for this session only.",
  );
});

it("createTokenStore puts only the first line of the error's message into the warning", async () => {
  const { warning } = await createTokenStore(async () => {
    throw new Error("Cannot find module '@napi-rs/keyring'\nRequire stack:\n- /Users/eleni/.dikigoros/helper/native/x.mjs");
  });
  expect(warning).toBe(
    "The OS keychain is not available on this machine (Cannot find module '@napi-rs/keyring'); the sign-in is kept in memory for this session only.",
  );
});

it("createTokenStore never puts a thrown value that is not an Error into the warning", async () => {
  const { store, warning } = await createTokenStore(() => Promise.reject("rt-leaked-secret"));
  expect(store.kind).toBe("memory");
  expect(warning).toBe(
    "The OS keychain is not available on this machine (unknown error); the sign-in is kept in memory for this session only.",
  );
});
