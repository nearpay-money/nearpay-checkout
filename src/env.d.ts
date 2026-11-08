/// <reference types="vite/client" />

/** Build-time constants injected by vite.config.ts (lld/checkout-and-js.md §2). */
declare const __NP_CONFIG__: {
  readonly apiOrigin: string;
  readonly sentinelKeys: readonly { readonly kid: string; readonly public_key: string }[];
  readonly turnstileSitekey: string;
  readonly walletConnectProjectId: string;
  readonly nearNetwork: "mainnet" | "testnet";
  readonly nearRpcUrl: string;
  readonly solanaRpcUrl: string;
};
/** True only in the mock-backed Playwright build (`vite build --mode e2e`). */
declare const __NP_E2E__: boolean;
