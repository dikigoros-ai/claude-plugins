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
    "dikigoros-ai": { type: string; url: string };
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

  it("list the remote connector dikigoros-ai at https://dikigoros.ai/mcp", () => {
    expect(manifest().mcpServers["dikigoros-ai"]).toMatchObject({ type: "http", url: "https://dikigoros.ai/mcp" });
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

describe("the third-party notices beside the bundle", () => {
  const notices = () => readFileSync(join(PLUGIN_ROOT, "server", "THIRD_PARTY_NOTICES.md"), "utf8");
  /** "## name@version — licence": a package's heading, not a line of a licence text that starts the same. */
  const headings = () =>
    notices()
      .split("\n")
      .filter((line) => /^## \S+@\S+ — /.test(line));

  it("give each bundled package a section, name@version and its licence, in order", () => {
    for (const name of ["pdfjs-dist", "@modelcontextprotocol/server", "@vercel/blob", "mammoth", "zod", "tar"]) {
      expect(headings().some((heading) => heading.startsWith(`## ${name}@`)), name).toBe(true);
    }
    expect(headings()).toContain("## pdfjs-dist@6.4.299 — Apache-2.0");
    expect(headings()).toEqual([...headings()].sort());
  });

  it("start with pdf.js's own notice, which the minified bundle drops, while its worker keeps it at its top", () => {
    expect(notices().indexOf(" * @licstart")).toBeLessThan(notices().indexOf("\n## "));
    expect(notices()).toMatch(/Copyright \d{4} Mozilla Foundation/);
    expect(readFileSync(join(PLUGIN_ROOT, "server", "pdf.worker.min.mjs"), "utf8")).toMatch(/^\/\*\*\n \* @licstart/);
  });
});

describe("the init-matter skill and the project picker", () => {
  const SKILL = join(PLUGIN_ROOT, "skills", "init-matter", "SKILL.md");
  /** The skill's frontmatter fields (one `key: value` per line) and its body. */
  const skill = () => {
    const text = readFileSync(SKILL, "utf8");
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
    if (match === null) throw new Error("SKILL.md has no frontmatter");
    const fields = Object.fromEntries(
      match[1].split("\n").map((line) => {
        const at = line.indexOf(":");
        return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^"(.*)"$/, "$1")];
      }),
    );
    return { fields, body: match[2] };
  };

  it("ships the skill, named init-matter, with a description within 1,024 characters", () => {
    const { fields } = skill();
    expect(fields.name).toBe("init-matter");
    expect(fields.description.length).toBeGreaterThan(0);
    expect(fields.description.length).toBeLessThanOrEqual(1024);
  });

  it("names the model's three tools and never the picker-only save_selection", () => {
    const { fields, body } = skill();
    for (const tool of ["scan_project", "show_project_picker", "init_matter"]) expect(body, tool).toContain(tool);
    expect(`${fields.description}\n${body}`).not.toContain("save_selection");
  });

  it("ships the picker's HTML beside the bundle", () => {
    const html = join(PLUGIN_ROOT, "server", "ui", "project-picker.html");
    expect(existsSync(html) && statSync(html).isFile()).toBe(true);
  });
});
