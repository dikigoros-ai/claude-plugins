// A value the server makes on first use, such as the native runtime it installs, shared by every
// caller after that.

/**
 * A function answering what `make` resolves to. The first call makes it; every later call, and
 * every call that arrives while it is being made, shares that promise. A rejection is not kept:
 * the calls waiting on it get it, and the next call makes the value again, so an install that
 * failed on a network blip is tried again by the next tool call.
 */
export function once<T>(make: () => Promise<T>): () => Promise<T> {
  let made: Promise<T> | undefined;
  return () =>
    (made ??= make().catch((err: unknown) => {
      made = undefined;
      throw err;
    }));
}
