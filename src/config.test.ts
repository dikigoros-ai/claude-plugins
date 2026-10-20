import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigError, type HelperConfig, loadConfig } from "./config";

const HOME = "/home/lawyer";

/** loadConfig({}, HOME), spelled out by hand. */
const DEFAULTS: HelperConfig = {
  baseUrl: "https://dikigoros.ai",
  audience: "https://dikigoros.ai/mcp",
  auth0Domain: "dikigoros-prod.eu.auth0.com",
  auth0ClientId: "",
  scopes: "openid offline_access matters:read matters:write account:read",
  dataDir: join(HOME, ".dikigoros", "helper"),
  openBrowser: true,
  nativeDirOverride: null,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The ConfigError loadConfig throws for this DIKIGOROS_BASE_URL; fails the test when it is accepted. */
function refusal(baseUrl: string): ConfigError {
  try {
    loadConfig({ DIKIGOROS_BASE_URL: baseUrl }, HOME);
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error(`loadConfig accepted DIKIGOROS_BASE_URL=${JSON.stringify(baseUrl)}`);
}

it("defaults to production: its audience and tenant, no client id, the home data dir, the browser on", () => {
  expect(loadConfig({}, HOME)).toEqual(DEFAULTS);
});

it("http://localhost:3000 gets its own audience and the staging tenant", () => {
  expect(loadConfig({ DIKIGOROS_BASE_URL: "http://localhost:3000" }, HOME)).toEqual({
    ...DEFAULTS,
    baseUrl: "http://localhost:3000",
    audience: "http://localhost:3000/mcp",
    auth0Domain: "dikigoros-staging.eu.auth0.com",
  });
});

it.each([
  ["https://dikigoros.ai/", "https://dikigoros.ai", "https://dikigoros.ai/mcp"],
  ["http://localhost:3000/", "http://localhost:3000", "http://localhost:3000/mcp"],
])("drops the trailing slash of %s", (given, baseUrl, audience) => {
  expect(loadConfig({ DIKIGOROS_BASE_URL: given }, HOME)).toMatchObject({ baseUrl, audience });
});

it.each([
  "https://dikigoros.example.vercel.app", // a deployment of the app, not its origin
  "http://localhost:3001",
  "https://dikigoros.ai//", // one trailing slash is dropped, not two
  "https://dikigoros.ai/mcp",
  "https://dikigoros.ai:443",
  "https://DIKIGOROS.ai",
  "http://dikigoros.ai",
  "https://dikigoros.ai.example.com",
  "http://127.0.0.1:3000",
  "https://dikigoros.ai ",
])("refuses DIKIGOROS_BASE_URL=%j with a one-line ConfigError naming the allowed origins", (baseUrl) => {
  const err = refusal(baseUrl);
  expect(err.message).toContain("DIKIGOROS_BASE_URL");
  expect(err.message).toContain("https://dikigoros.ai");
  expect(err.message).toContain("http://localhost:3000");
  expect(err.message).not.toContain("\n");
});

it("does not repeat a refused base URL, which may carry credentials", () => {
  expect(refusal("https://lawyer:s3cret@dikigoros.ai").message).not.toContain("s3cret");
});

it("DIKIGOROS_AUTH0_DOMAIN replaces the tenant of either origin", () => {
  const tenant = { DIKIGOROS_AUTH0_DOMAIN: "tenant.example.auth0.com" };
  expect(loadConfig(tenant, HOME).auth0Domain).toBe("tenant.example.auth0.com");
  expect(loadConfig({ ...tenant, DIKIGOROS_BASE_URL: "http://localhost:3000" }, HOME).auth0Domain).toBe(
    "tenant.example.auth0.com",
  );
});

it("takes the client id from DIKIGOROS_AUTH0_CLIENT_ID", () => {
  expect(loadConfig({ DIKIGOROS_AUTH0_CLIENT_ID: "Xy12abc" }, HOME).auth0ClientId).toBe("Xy12abc");
});

it("keeps its files in CLAUDE_PLUGIN_DATA when the host sets it", () => {
  expect(loadConfig({ CLAUDE_PLUGIN_DATA: "/plugin-data/dikigoros" }, HOME).dataDir).toBe("/plugin-data/dikigoros");
});

it.each([
  { value: "1", openBrowser: false },
  { value: "0", openBrowser: true },
  { value: "true", openBrowser: true },
])("DIKIGOROS_NO_BROWSER=$value gives openBrowser $openBrowser", ({ value, openBrowser }) => {
  expect(loadConfig({ DIKIGOROS_NO_BROWSER: value }, HOME).openBrowser).toBe(openBrowser);
});

it("DIKIGOROS_HELPER_NATIVE_DIR becomes the native directory override", () => {
  expect(loadConfig({ DIKIGOROS_HELPER_NATIVE_DIR: "/opt/dikigoros/node_modules" }, HOME).nativeDirOverride).toBe(
    "/opt/dikigoros/node_modules",
  );
});

it("reads a variable set to the empty string as unset", () => {
  const empty = {
    DIKIGOROS_BASE_URL: "",
    DIKIGOROS_AUTH0_DOMAIN: "",
    DIKIGOROS_AUTH0_CLIENT_ID: "",
    CLAUDE_PLUGIN_DATA: "",
    DIKIGOROS_NO_BROWSER: "",
    DIKIGOROS_HELPER_NATIVE_DIR: "",
  };
  expect(loadConfig(empty, HOME)).toEqual(DEFAULTS);
});

it("reads only the environment it is given, never process.env", () => {
  vi.stubEnv("DIKIGOROS_BASE_URL", "https://example.com");
  vi.stubEnv("DIKIGOROS_AUTH0_DOMAIN", "elsewhere.auth0.com");
  vi.stubEnv("CLAUDE_PLUGIN_DATA", "/elsewhere");
  vi.stubEnv("DIKIGOROS_NO_BROWSER", "1");
  vi.stubEnv("DIKIGOROS_HELPER_NATIVE_DIR", "/elsewhere/node_modules");
  expect(loadConfig({}, HOME)).toEqual(DEFAULTS);
});
