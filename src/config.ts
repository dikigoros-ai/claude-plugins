// The helper's settings, from the environment its host gives the server process (the plugin
// manifest's `env`, or a developer's shell). The two origins the helper may talk to are spelled
// here and nowhere else; any other DIKIGOROS_BASE_URL is refused before anything starts.

import { join } from "node:path";

export const ALLOWED_ORIGINS = ["https://dikigoros.ai", "http://localhost:3000"] as const;

/** What the device authorization grant asks for; `offline_access` brings the refresh token. */
export const DEVICE_SCOPES = "openid offline_access matters:read matters:write account:read";

export interface HelperConfig {
  /** One of ALLOWED_ORIGINS, without a trailing slash. */
  baseUrl: string;
  /** `${baseUrl}/mcp`: the API the access token is for, the same audience as the remote connector's. */
  audience: string;
  auth0Domain: string;
  /** "" while unconfigured; sign-in is refused until it is set. */
  auth0ClientId: string;
  scopes: string;
  /** Where the helper keeps its own files (the native runtime it installs). */
  dataDir: string;
  /** Whether sign-in opens the verification URL in a browser. */
  openBrowser: boolean;
  /** A node_modules directory that already holds the native packages, used instead of installing them. */
  nativeDirOverride: string | null;
}

export class ConfigError extends Error {}

type AllowedOrigin = (typeof ALLOWED_ORIGINS)[number];

const [PRODUCTION_ORIGIN, LOCAL_ORIGIN] = ALLOWED_ORIGINS;

/** The Auth0 tenant each origin signs in with, unless DIKIGOROS_AUTH0_DOMAIN names another. */
const DEFAULT_AUTH0_DOMAIN: Record<AllowedOrigin, string> = {
  [PRODUCTION_ORIGIN]: "dikigoros-prod.eu.auth0.com",
  [LOCAL_ORIGIN]: "dikigoros-staging.eu.auth0.com",
};

/**
 * The configuration `env` describes. Pure: it reads its two arguments and nothing else (not
 * process.env, not os.homedir()). A variable set to "" counts as unset. Throws ConfigError when
 * DIKIGOROS_BASE_URL, less one trailing slash, is not byte for byte one of ALLOWED_ORIGINS.
 */
export function loadConfig(env: NodeJS.ProcessEnv, homeDir: string): HelperConfig {
  const baseUrl = allowedOrigin(setting(env.DIKIGOROS_BASE_URL) ?? PRODUCTION_ORIGIN);
  return {
    baseUrl,
    audience: `${baseUrl}/mcp`,
    auth0Domain: setting(env.DIKIGOROS_AUTH0_DOMAIN) ?? DEFAULT_AUTH0_DOMAIN[baseUrl],
    auth0ClientId: setting(env.DIKIGOROS_AUTH0_CLIENT_ID) ?? "",
    scopes: DEVICE_SCOPES,
    dataDir: setting(env.CLAUDE_PLUGIN_DATA) ?? join(homeDir, ".dikigoros", "helper"),
    openBrowser: env.DIKIGOROS_NO_BROWSER !== "1",
    nativeDirOverride: setting(env.DIKIGOROS_HELPER_NATIVE_DIR) ?? null,
  };
}

/** `raw` less one trailing slash, when that is exactly an allowed origin. */
function allowedOrigin(raw: string): AllowedOrigin {
  const url = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  const origin = ALLOWED_ORIGINS.find((allowed) => allowed === url);
  // The refused value is not repeated: a URL can carry credentials (https://user:password@host).
  if (origin === undefined) throw new ConfigError(`DIKIGOROS_BASE_URL must be one of ${ALLOWED_ORIGINS.join(", ")}`);
  return origin;
}

/** An environment variable's value, "" read as unset. */
function setting(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}
