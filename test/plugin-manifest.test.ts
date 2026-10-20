// The plugin as Claude's plugin loader reads it: the marketplace at the repository root, its one
// entry, and the manifest of the plugin that entry points at, which lists the remote connector and
// the bundled local server. Static checks on the committed files; plugin-smoke.test.ts runs the
// server itself.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_ROOT = join(ROOT, "plugins", "dikigoros");

interface MarketplaceEntry {
  name: string;
  source: string;
  version: string;
}

interface PluginManifest {
  name: string;
  version: string;
  mcpServers: {
    dikigoros: { type: string; url: string };
    "dikigoros-upload": { command: string; args: string[] };
  };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

const marketplace = () => readJson<{ plugins: MarketplaceEntry[] }>(join(ROOT, ".claude-plugin", "marketplace.json"));
const manifest = () => readJson<PluginManifest>(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"));
/** The marketplace's one plugin. */
const entry = () => marketplace().plugins[0];

describe("the marketplace and the plugin manifest", () => {
  it("parse as JSON, the marketplace listing one plugin", () => {
    expect(marketplace().plugins).toHaveLength(1);
    expect(manifest()).toBeTypeOf("object");
  });

  it("give the marketplace entry the manifest's name", () => {
    expect(entry().name).toBe(manifest().name);
  });

  it("point the entry's source at a directory that exists", () => {
    const source = join(ROOT, entry().source);
    expect(existsSync(source) && statSync(source).isDirectory()).toBe(true);
  });

  it("carry one version in plugin.json, the marketplace entry and package.json", () => {
    const { version } = manifest();
    expect(entry().version).toBe(version);
    expect(readJson<{ version: string }>(join(ROOT, "package.json")).version).toBe(version);
  });

  it("have no bin/ directory at the plugin root, which claude.ai and Cowork refuse", () => {
    expect(existsSync(join(PLUGIN_ROOT, "bin"))).toBe(false);
  });

  it("list the remote connector at https://dikigoros.ai/mcp", () => {
    expect(manifest().mcpServers.dikigoros).toMatchObject({ type: "http", url: "https://dikigoros.ai/mcp" });
  });

  it("start the local server from a file in the plugin", () => {
    const [script] = manifest().mcpServers["dikigoros-upload"].args;
    const file = script.replace("${CLAUDE_PLUGIN_ROOT}", PLUGIN_ROOT);
    expect(existsSync(file) && statSync(file).isFile(), file).toBe(true);
  });

  it("start it without an env: a manifest value would override the shell's and the per-origin defaults", () => {
    expect(manifest().mcpServers["dikigoros-upload"]).not.toHaveProperty("env");
  });

  it("ask for no settings at install (no userConfig)", () => {
    expect(manifest()).not.toHaveProperty("userConfig");
    expect(entry()).not.toHaveProperty("userConfig");
  });
});
