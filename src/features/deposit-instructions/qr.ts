/**
 * QR payload (lld/checkout-and-js.md §5.5): EIP-681 for EVM tokens
 * (`ethereum:<token>@<chainId>/transfer?address=<deposit>&uint256=<amount_in>`), the plain address
 * otherwise. Built only from attested instructions.
 */
import type { WalletAsset } from "../../lib/chains/chains";

export function qrPayload(address: string, amountIn: string, asset: WalletAsset | null): string {
  if (asset?.kind === "evm_erc20") {
    return `ethereum:${asset.token}@${asset.chainId}/transfer?address=${address}&uint256=${amountIn}`;
  }
  return address;
}

/** Remaining time until `until` (epoch ms) as `m:ss` / `h:mm:ss`. */
export function countdown(until: number, now: number): { readonly ms: number; readonly label: string } {
  const ms = Math.max(0, until - now);
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return { ms, label: h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}` };
}
