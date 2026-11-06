/**
 * NEAR wallets through NEAR Connect (ADR-0010, lld/checkout-and-js.md §3), loaded lazily on "Pay with
 * wallet". NEAR Connect runs each wallet's executor in a sandboxed `srcdoc` frame that inherits this
 * page's CSP, so it needs the per-response nonce (`cspNonce()`); without it NEAR wallets stay disabled
 * instead of weakening the policy. Its popup injects `<style>` elements without a nonce; they are
 * re-inserted with the nonce (we vouch for CSS shipped in our own bundle).
 *
 * The mock-backed Playwright build (`__NP_E2E__`) uses a test wallet injected by the test instead.
 */
import { config, cspNonce } from "../../config";
import type { NearTransaction } from "./tx";

export interface NearSignedMessage {
  readonly accountId: string;
  readonly publicKey: string;
  readonly signature: string;
}

export interface NearWallet {
  readonly accountId: string;
  readonly label: string;
  signAndSendTransactions(transactions: readonly NearTransaction[]): Promise<unknown>;
  signMessage(p: { message: string; recipient: string; nonce: Uint8Array }): Promise<NearSignedMessage>;
}

export class NearUnavailable extends Error {
  constructor() {
    super("NEAR wallets are unavailable on this page");
    this.name = "NearUnavailable";
  }
}

declare global {
  interface Window {
    /** Test wallet for the e2e build only (ignored by production builds). */
    __NP_E2E_NEAR_WALLET__?: NearWallet;
  }
}

/** Whether NEAR wallets can be offered (nonce present, or the e2e test wallet). */
export function nearAvailable(): boolean {
  if (__NP_E2E__) return Boolean(window.__NP_E2E_NEAR_WALLET__);
  return cspNonce() !== null;
}

let styleGuard: MutationObserver | null = null;

function guardStyles(nonce: string): void {
  if (styleGuard) return;
  styleGuard = new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n instanceof HTMLStyleElement && !n.nonce && !n.dataset.npNonced) {
          const copy = document.createElement("style");
          copy.nonce = nonce;
          copy.dataset.npNonced = "1";
          copy.textContent = n.textContent;
          n.after(copy);
          n.remove();
        }
      }
    }
  });
  styleGuard.observe(document.head, { childList: true });
}

export async function connectNearWallet(): Promise<NearWallet> {
  if (__NP_E2E__) {
    const w = window.__NP_E2E_NEAR_WALLET__;
    if (!w) throw new NearUnavailable();
    return w;
  }
  const nonce = cspNonce();
  if (!nonce) throw new NearUnavailable();
  guardStyles(nonce);
  const { NearConnector } = await import("@hot-labs/near-connect");
  const connector = new NearConnector({
    network: config.nearNetwork,
    cspNonce: nonce,
    footerBranding: null,
    providers: { [config.nearNetwork]: [config.nearRpcUrl] },
    features: { signAndSendTransactions: true, signMessage: true },
  });
  const wallet = await connector.connect();
  const accounts = await wallet.getAccounts({ network: config.nearNetwork });
  const accountId = accounts[0]?.accountId;
  if (!accountId) throw new Error("The wallet returned no account.");
  return {
    accountId,
    label: wallet.manifest.name,
    signAndSendTransactions: (transactions) =>
      wallet.signAndSendTransactions({
        network: config.nearNetwork,
        transactions: transactions.map((t) => ({ receiverId: t.receiverId, actions: [...t.actions] })),
      } as unknown as Parameters<typeof wallet.signAndSendTransactions>[0]),
    signMessage: (p) => wallet.signMessage({ ...p, network: config.nearNetwork }),
  };
}
