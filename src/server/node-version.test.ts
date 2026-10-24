import { expect, it } from "vitest";
import { isSupportedNode } from "./node-version";

it.each([
  ["22.13.0", true],
  ["22.13.1", true],
  ["22.20.0", true],
  ["23.0.0", true],
  ["24.1.0", true],
  ["22.12.9", false],
  ["22.0.0", false],
  ["20.18.1", false],
  ["18.20.4", false],
])("Node.js %s is supported: %s", (version, supported) => {
  expect(isSupportedNode(version)).toBe(supported);
});

it("reads a pre-release by its numbers", () => {
  expect(isSupportedNode("22.13.0-rc.1")).toBe(true);
  expect(isSupportedNode("22.12.0-nightly20241201")).toBe(false);
});
