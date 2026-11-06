/**
 * Keeps NEAR Connect on the reviewed wallet manifest (`./manifest.ts`, lld/checkout-and-js.md §10).
 *
 * How @hot-labs/near-connect 0.11.4 loads wallet code: for a `sandbox` wallet it `fetch`es the manifest's
 * `executor` URL (adding `?nonce=<per-page uuid>`) as text, caches the text in IndexedDB (`hot-connector` /
 * `wallets`, key `<id>:<version>`, and the cached copy wins over the network), and inlines it into a
 * `<script type="module" nonce>` of an `<iframe sandbox="allow-scripts" srcdoc>` that inherits this page's CSP.
 * The library takes no integrity option, so this module:
 * - hands the connector a copy of the pinned manifest (executors at full commit SHAs, never a branch);
 * - wraps `fetch` so requests for a pinned executor carry the SRI `integrity` of the reviewed file (the browser
 *   then refuses any other bytes, even from GitHub);
 * - drops cached executors whose hash is not the pinned one before any wallet runs;
 * - refuses wallets that did not come from the snapshot: debug wallets (added in the popup's settings), wallets
 *   announced by another window with `postMessage` (`ParentFrameWallet`: no origin check, so a merchant page
 *   framing the embedded checkout could inject one), and debug wallets persisted in storage. Browser-extension
 *   wallets (`InjectedWallet`, announced in this document) stay allowed, like EIP-6963 wallets.
 */
import { NEAR_EXECUTOR_INTEGRITY, PINNED_NEAR_MANIFEST, type PinnedWalletManifest } from "./manifest";

export interface PinnedManifest {
  readonly version: string;
  readonly wallets: readonly PinnedWalletManifest[];
}

export class UnpinnedWalletError extends Error {
  constructor(id: string | undefined) {
    super(`The wallet "${id ?? "unknown"}" is not in the pinned NEAR wallet list.`);
    this.name = "UnpinnedWalletError";
  }
}

/** A fresh, mutable copy of the snapshot (NearConnector reassigns `manifest.wallets` on the object it gets). */
export function pinnedManifest(manifest: PinnedManifest = PINNED_NEAR_MANIFEST): {
  version: string;
  wallets: PinnedWalletManifest[];
} {
  return structuredClone({ version: manifest.version, wallets: [...manifest.wallets] });
}

type FetchInput = string | URL | Request;

function requestUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** The SRI hash for a request to a pinned executor (the library's `nonce` cache-buster ignored), else undefined. */
export function executorIntegrity(
  input: FetchInput,
  integrity: Readonly<Record<string, string>> = NEAR_EXECUTOR_INTEGRITY,
): string | undefined {
  let url: URL;
  try {
    url = new URL(requestUrl(input));
  } catch {
    return undefined;
  }
  url.searchParams.delete("nonce");
  url.hash = "";
  return Object.hasOwn(integrity, url.href) ? integrity[url.href] : undefined;
}

const WRAPPED = Symbol.for("nearpay.near-executor-integrity");
type MarkedFetch = typeof fetch & { [WRAPPED]?: true };

/** Wraps `scope.fetch` once: pinned executor requests get `integrity` (and no credentials); others pass through. */
export function installExecutorIntegrity(
  integrity: Readonly<Record<string, string>> = NEAR_EXECUTOR_INTEGRITY,
  scope: { fetch: typeof fetch } = globalThis,
): void {
  if ((scope.fetch as MarkedFetch)[WRAPPED]) return;
  const inner = scope.fetch;
  const wrapped: MarkedFetch = (input, init) => {
    const sri = executorIntegrity(input, integrity);
    return sri ? inner(input, { ...init, integrity: sri, credentials: "omit" }) : inner(input, init);
  };
  wrapped[WRAPPED] = true;
  scope.fetch = wrapped;
}

/** SRI form of a sha384 digest of `text` encoded as UTF-8 (what the library caches is `response.text()`). */
export async function sri384(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-384", new TextEncoder().encode(text)));
  let bin = "";
  for (const b of digest) bin += String.fromCharCode(b);
  return `sha384-${btoa(bin)}`;
}

export interface ExecutorCache {
  getItem<T>(key: string): Promise<T | null>;
  removeItem(key: string): Promise<void>;
}

/**
 * Removes cached executors that are not byte-for-byte the pinned file (e.g. cached from `main` before the
 * pin). A cache that cannot be read is ignored (the library then downloads, with integrity); a failed removal
 * throws so no unverified code can run.
 */
export async function purgeUnpinnedExecutors(
  cache: ExecutorCache,
  manifest: PinnedManifest = PINNED_NEAR_MANIFEST,
  integrity: Readonly<Record<string, string>> = NEAR_EXECUTOR_INTEGRITY,
): Promise<void> {
  for (const wallet of manifest.wallets) {
    const key = `${wallet.id}:${wallet.version}`;
    const code = await cache.getItem<unknown>(key).catch(() => null);
    if (code == null) continue;
    if (typeof code === "string" && (await sri384(code)) === integrity[wallet.executor]) continue;
    await cache.removeItem(key);
  }
}

interface StorageLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** The connector's storage minus `debug-wallets`, so wallets added in the popup's settings never persist. */
export function withoutDebugWallets(inner: StorageLike): StorageLike {
  const DEBUG = "debug-wallets";
  return {
    get: (key) => (key === DEBUG ? Promise.resolve(null) : inner.get(key)),
    set: (key, value) => (key === DEBUG ? Promise.resolve() : inner.set(key, value)),
    remove: (key) => inner.remove(key),
  };
}

// biome-ignore lint/suspicious/noExplicitAny: constructor signatures of the library's wallet classes
type WalletClass = abstract new (...args: any[]) => unknown;

/** The library's wallet classes (taken from the same module instance as the connector). */
export interface WalletClasses {
  readonly SandboxWallet: WalletClass;
  readonly InjectedWallet: WalletClass;
}

interface WalletWithManifest {
  readonly manifest?: { readonly id?: string; readonly executor?: string; readonly debug?: boolean };
}

/** Throws unless `wallet` is a browser-extension wallet or a sandbox wallet exactly as pinned. */
export function assertPinnedWallet(
  wallet: WalletWithManifest,
  classes: WalletClasses,
  manifest: PinnedManifest = PINNED_NEAR_MANIFEST,
): void {
  const m = wallet.manifest;
  if (wallet instanceof classes.InjectedWallet) return;
  if (wallet instanceof classes.SandboxWallet && m && !m.debug) {
    const pin = manifest.wallets.find((w) => w.id === m.id);
    if (pin && pin.executor === m.executor) return;
  }
  throw new UnpinnedWalletError(m?.id);
}

export interface PinnedConnector<W> {
  readonly db: ExecutorCache;
  selectWallet(): Promise<string>;
  wallet(id: string): Promise<W>;
  connect(input: { walletId: string }): Promise<W>;
}

/**
 * Lets the payer pick a wallet, checks it before and after sign-in (another window could swap a wallet with
 * the same id in between), and only then hands it out. Stale cached executors are dropped first.
 */
export async function connectPinnedWallet<W extends WalletWithManifest>(
  connector: PinnedConnector<W>,
  classes: WalletClasses,
  manifest: PinnedManifest = PINNED_NEAR_MANIFEST,
): Promise<W> {
  await purgeUnpinnedExecutors(connector.db, manifest);
  const walletId = await connector.selectWallet();
  assertPinnedWallet(await connector.wallet(walletId), classes, manifest);
  const wallet = await connector.connect({ walletId });
  assertPinnedWallet(wallet, classes, manifest);
  return wallet;
}
