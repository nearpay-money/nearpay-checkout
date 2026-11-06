/** Runtime view of the build-time configuration (never secret: everything here ships in the bundle). */
export interface CheckoutConfig {
  readonly apiOrigin: string;
  readonly sentinelKeys: readonly { readonly kid: string; readonly public_key: string }[];
  readonly turnstileSitekey: string;
  readonly walletConnectProjectId: string;
  readonly nearNetwork: "mainnet" | "testnet";
  readonly nearRpcUrl: string;
  readonly e2e: boolean;
}

export const config: CheckoutConfig = Object.freeze({ ...__NP_CONFIG__, e2e: __NP_E2E__ });

/**
 * Per-response CSP nonce written by the static server into `<meta name="np-csp-nonce">`. Until the
 * server substitutes it the placeholder stays (an invalid CSP source), and features that need a nonce
 * (NEAR Connect's sandboxed wallet frames) stay disabled.
 */
export function cspNonce(doc: Document = document): string | null {
  const v = doc.querySelector('meta[name="np-csp-nonce"]')?.getAttribute("content") ?? "";
  return /^[A-Za-z0-9+/_-]{16,}={0,2}$/.test(v) ? v : null;
}
