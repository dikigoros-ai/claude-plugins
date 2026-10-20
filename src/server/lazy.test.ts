import { describe, expect, it, vi } from "vitest";
import { once } from "./lazy";

const NODE_MODULES = "/Users/eleni/.dikigoros/helper/native/0f3c8a1b2d4e/node_modules";

describe("once", () => {
  it("makes the value on the first call and hands the same one to every later call", async () => {
    const make = vi.fn(async () => ({ nodeModulesDir: NODE_MODULES }));
    const lazy = once(make);
    const values = [await lazy(), await lazy(), await lazy()];

    expect(make).toHaveBeenCalledTimes(1);
    expect(values[1]).toBe(values[0]);
    expect(values[2]).toBe(values[0]);
  });

  it("forgets a rejection, so that the next call makes the value again", async () => {
    const make = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("Download failed for @napi-rs/canvas: fetch failed"))
      .mockResolvedValueOnce(NODE_MODULES);
    const lazy = once(make);

    await expect(lazy()).rejects.toThrow("Download failed for @napi-rs/canvas: fetch failed");
    await expect(lazy()).resolves.toBe(NODE_MODULES);
    expect(make).toHaveBeenCalledTimes(2);
  });

  it("shares one attempt among the calls that arrive while it runs, its rejection included", async () => {
    let fail: (err: Error) => void = () => {};
    const make = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(
        () =>
          new Promise<string>((_, reject) => {
            fail = reject;
          }),
      )
      .mockResolvedValueOnce(NODE_MODULES);
    const lazy = once(make);
    const first = lazy();
    const second = lazy();
    fail(new Error("Integrity mismatch for @napi-rs/canvas"));

    await expect(first).rejects.toThrow("Integrity mismatch for @napi-rs/canvas");
    await expect(second).rejects.toThrow("Integrity mismatch for @napi-rs/canvas");
    expect(make).toHaveBeenCalledTimes(1);
    await expect(lazy()).resolves.toBe(NODE_MODULES);
    expect(make).toHaveBeenCalledTimes(2);
  });
});
