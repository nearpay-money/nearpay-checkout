/**
 * QR payload (lld/checkout-and-js.md §5.5, §11): EIP-681 for EVM tokens
 * (`ethereum:<token>@<chainId>/transfer?address=<deposit>&uint256=<amount_in>`), Solana Pay transfer
 * requests and BIP-21 URIs (Stage 4), the plain address otherwise. Built only from attested instructions.
 */
import type { Attestation } from "@nearpay-money/spec";
import { BITCOIN_MAINNET, bip21Uri, parseOmftAssetId, SOLANA_MAINNET, solanaPayUri } from "@nearpay-money/spec";
import type { WalletAsset } from "../../lib/chains/chains";
import { isSolanaAddress, SOL_ASSET_ID, splAssetToken } from "../../wallets/solana/tx";

export const BTC_ASSET_ID = "nep141:btc.omft.near";

/**
 * Payment URI of attested manual-path instructions (§11), or null when none applies:
 * - Solana: `solana:<deposit>?amount=<decimal>[&spl-token=<mint>]` — needs the attested asset (decimals);
 *   SOL needs a `native` token, an SPL token needs an attested mint that reproduces the asset id
 *   (an amount without the right mint would ask for SOL). No memo/reference: only when memo is null.
 * - Bitcoin: `bitcoin:<deposit>?amount=<BTC>` for native BTC (8 decimals), memo null.
 */
export function paymentUri(att: Pick<Attestation, "deposit" | "asset">): string | null {
  const d = att.deposit;
  if (!d || d.memo !== null || !/^[1-9][0-9]{0,77}$/.test(d.amount_in)) return null;
  const a = att.asset && att.asset.asset_id === d.origin_asset_id ? att.asset : null;
  if (d.chain === BITCOIN_MAINNET) {
    if (d.origin_asset_id !== BTC_ASSET_ID || (a && a.decimals !== 8)) return null;
    return bip21Uri(d.address, d.amount_in);
  }
  if (d.chain !== SOLANA_MAINNET || !a || !isSolanaAddress(d.address)) return null;
  if (a.asset_id === SOL_ASSET_ID) {
    return a.token?.standard === "native" && a.decimals === 9 ? solanaPayUri(d.address, d.amount_in, 9, null) : null;
  }
  const mint = a.token?.standard === "spl" ? a.token.address : null;
  const omft = parseOmftAssetId(a.asset_id);
  if (!mint || !isSolanaAddress(mint) || omft?.kind !== "hash20" || omft.blockchain !== "sol") return null;
  if (omft.token !== splAssetToken(mint)) return null;
  return solanaPayUri(d.address, d.amount_in, a.decimals, mint);
}

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
