import { expect, it } from "vitest";
import { firstLine, isRecord, reason } from "./util";

it("firstLine keeps an error's first line, whatever its line ends, and a thrown value's own", () => {
  expect(firstLine(new Error("fetch failed\n    at node:internal/deps/undici:1:1"))).toBe("fetch failed");
  expect(firstLine(new TypeError("first\r\nsecond"))).toBe("first");
  expect(firstLine("no answer\nat all")).toBe("no answer");
  expect(firstLine(404)).toBe("404");
});

it("reason keeps an error's first line, and never shows a value thrown in place of an Error", () => {
  expect(reason(new Error("Platform secure storage failure\nat keyring"))).toBe("Platform secure storage failure");
  expect(reason("rt-leaked-secret")).toBe("unknown error");
  expect(reason(undefined)).toBe("unknown error");
});

it("isRecord takes a JSON object, not null, an array or a primitive", () => {
  expect(isRecord({ error: "Not found" })).toBe(true);
  expect(isRecord({})).toBe(true);
  for (const value of [null, undefined, [], ["a"], "text", 1, true]) expect(isRecord(value)).toBe(false);
});
