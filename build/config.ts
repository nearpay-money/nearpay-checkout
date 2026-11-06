/**
 * Build-time configuration (lld/checkout-and-js.md §2). Runs in Node inside `vite.config.ts`; every
 * value ends up as a constant in the static bundle, so nothing here may be secret.
 *
 * - Sentinel keys are PINNED at build time (FR-PAY-10, ADR-0010): `VITE_SENTINEL_KEYS` (JSON), else
 *   the file named by `NP_SENTINEL_KEYS_FILE`, else `../nearpay-deploy/.secrets/public/sentinel_keys.json`
 *   (written by `nearpay-deploy/scripts/seed.sh keys`). A production build without keys fails.
 * - The e2e build (`--mode e2e`) pins the shared spec test-vector key instead and writes `dist-e2e/`.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

export interface PinnedKey {
  readonly kid: string;
  readonly public_key: string;
}

export interface CheckoutBuildConfig {
  readonly apiOrigin: string;
  readonly sentinelKeys: readonly PinnedKey[];
  readonly turnstileSitekey: string;
  readonly walletConnectProjectId: string;
  readonly nearNetwork: "mainnet" | "testnet";
  readonly nearRpcUrl: string;
  readonly e2e: boolean;
}

/** Cloudflare's documented always-pass Turnstile test sitekey (pairs with the local stack's test secret). */
export const TURNSTILE_TEST_SITEKEY = "1x00000000000000000000AA";
const KID_RE = /^[a-z0-9-]{1,64}$/;
const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;
/** Placeholder the static server replaces with a per-response nonce (invalid as a CSP source until then). */
export const CSP_NONCE_PLACEHOLDER = "{{NP_CSP_NONCE}}";

export function parseSentinelKeys(json: string, source: string): PinnedKey[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error(`sentinel keys from ${source} are not valid JSON`);
  }
  if (!Array.isArray(raw) || raw.length === 0)
    throw new Error(`sentinel keys from ${source} must be a non-empty array`);
  const seen = new Set<string>();
  return raw.map((k, i) => {
    if (typeof k !== "object" || k === null) throw new Error(`sentinel key #${i} from ${source} is not an object`);
    const { kid, public_key } = k as Record<string, unknown>;
    if (typeof kid !== "string" || !KID_RE.test(kid)) throw new Error(`sentinel key #${i} from ${source}: bad kid`);
    if (typeof public_key !== "string" || !B64URL_32.test(public_key))
      throw new Error(`sentinel key ${kid} from ${source}: public_key must be 32 bytes base64url`);
    if (seen.has(kid)) throw new Error(`sentinel key ${kid} from ${source} is listed twice`);
    seen.add(kid);
    return { kid, public_key };
  });
}

/** The spec's shared test-vector key (`@nearpay/spec/test-vectors/sentinel-attestation.json`). */
export function testVectorKey(root: string): PinnedKey {
  const require = createRequire(join(root, "package.json"));
  const file = require.resolve("@nearpay/spec/test-vectors/sentinel-attestation.json");
  const v = JSON.parse(readFileSync(file, "utf8")) as { key: { kid: string; public_key_base64url: string } };
  return { kid: v.key.kid, public_key: v.key.public_key_base64url };
}

export function resolveSentinelKeys(env: Record<string, string | undefined>, root: string, e2e: boolean): PinnedKey[] {
  if (e2e) return [testVectorKey(root)];
  if (env.VITE_SENTINEL_KEYS) return parseSentinelKeys(env.VITE_SENTINEL_KEYS, "VITE_SENTINEL_KEYS");
  const file = env.NP_SENTINEL_KEYS_FILE
    ? resolve(root, env.NP_SENTINEL_KEYS_FILE)
    : resolve(root, "..", "nearpay-deploy", ".secrets", "public", "sentinel_keys.json");
  if (!existsSync(file)) {
    throw new Error(
      `no pinned sentinel keys: set VITE_SENTINEL_KEYS or NP_SENTINEL_KEYS_FILE, or run nearpay-deploy/scripts/seed.sh keys (looked for ${file})`,
    );
  }
  return parseSentinelKeys(readFileSync(file, "utf8"), file);
}

function absoluteOrigin(url: string, name: string): string | null {
  if (url.startsWith("/")) return null; // same origin (the gateway routes /api on pay.<domain>)
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`${name} must be an absolute https URL or a path, got ${url}`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname)))
    throw new Error(`${name} must use https, got ${url}`);
  return u.origin;
}

export function resolveConfig(
  env: Record<string, string | undefined>,
  root: string,
  mode: string,
): CheckoutBuildConfig {
  const e2e = mode === "e2e";
  const apiOrigin = (env.VITE_API_ORIGIN ?? "/api").replace(/\/+$/, "");
  absoluteOrigin(apiOrigin, "VITE_API_ORIGIN");
  const nearNetwork = (env.VITE_NEAR_NETWORK ?? "mainnet") as CheckoutBuildConfig["nearNetwork"];
  if (nearNetwork !== "mainnet" && nearNetwork !== "testnet")
    throw new Error("VITE_NEAR_NETWORK must be mainnet or testnet");
  const nearRpcUrl =
    env.VITE_NEAR_RPC_URL ??
    (nearNetwork === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com");
  absoluteOrigin(nearRpcUrl, "VITE_NEAR_RPC_URL");
  return {
    apiOrigin,
    sentinelKeys: resolveSentinelKeys(env, root, e2e),
    turnstileSitekey: env.VITE_TURNSTILE_SITEKEY ?? TURNSTILE_TEST_SITEKEY,
    walletConnectProjectId: env.VITE_WALLETCONNECT_PROJECT_ID ?? "",
    nearNetwork,
    nearRpcUrl,
    e2e,
  };
}

/** NEAR Connect fetches its wallet manifest and wallet executors from these hosts. */
export const NEAR_CONNECT_HOSTS = ["https://raw.githubusercontent.com", "https://cdn.jsdelivr.net"] as const;
const TURNSTILE = "https://challenges.cloudflare.com";

/**
 * Content-Security-Policy of index.html (§2). `frame-ancestors` cannot be set from a meta tag; the
 * static server sends it per route (hosted: 'none'; /embed/: https: + local http).
 */
export function contentSecurityPolicy(c: CheckoutBuildConfig): string {
  const connect = new Set<string>(["'self'"]);
  const api = absoluteOrigin(c.apiOrigin, "VITE_API_ORIGIN");
  if (api) connect.add(api);
  const rpc = absoluteOrigin(c.nearRpcUrl, "VITE_NEAR_RPC_URL");
  if (rpc) connect.add(rpc);
  for (const h of NEAR_CONNECT_HOSTS) connect.add(h);
  const nonce = `'nonce-${CSP_NONCE_PLACEHOLDER}'`;
  return [
    "default-src 'none'",
    `script-src 'self' ${nonce} ${TURNSTILE}`,
    `style-src 'self' ${nonce}`,
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${[...connect].join(" ")}`,
    `frame-src ${TURNSTILE}`,
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
}
