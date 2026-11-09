/**
 * PLACEHOLDER for `@nearpay/spec` 0.4.0 (Stage 4, step 4.3 Phase A) — chains part: copied from the spec
 * source `stage-4/4.1-contracts` `src/common/chains.ts` (pure helpers, no schema code, so the initial
 * bundle carries nothing else of the placeholder).
 *
 * Phase B (spec 0.4.0 published): bump `@nearpay/spec`, import the same names from `@nearpay/spec`,
 * delete the whole `src/lib/spec-gap-0.4.0/` directory and `test/fixtures/spec-0.4.0/`.
 */

/** CAIP-2 id of Solana mainnet. */
export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;
/** CAIP-2 id of Bitcoin mainnet. */
export const BITCOIN_MAINNET = "bip122:000000000019d6689c085ae165831e93" as const;

/** Exact decimal of base units (no exponent, no float, trailing zeros trimmed). */
export function formatBaseUnits(amount: string, decimals: number): string {
  if (!/^(0|[1-9][0-9]*)$/.test(amount)) throw new RangeError(`not a base-unit integer string: ${amount}`);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new RangeError(`bad decimals: ${decimals}`);
  if (decimals === 0) return amount;
  const padded = amount.padStart(decimals + 1, "0");
  const int = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

/** BIP-21 `bitcoin:<address>?amount=<BTC>` (amount from satoshis, exact). */
export function bip21Uri(address: string, amountSats: string): string {
  return `bitcoin:${address}?amount=${formatBaseUnits(amountSats, 8)}`;
}

/** Solana Pay transfer request `solana:<recipient>?amount=<decimal>[&spl-token=<mint>]` (no reference/memo). */
export function solanaPayUri(recipient: string, amountBase: string, decimals: number, splMint: string | null): string {
  const amount = formatBaseUnits(amountBase, decimals);
  return `solana:${recipient}?amount=${amount}${splMint ? `&spl-token=${splMint}` : ""}`;
}

/** Parsed omft bridge asset id `nep141:<blockchain>[-<token>].omft.near`. */
export interface OmftAsset {
  readonly blockchain: string;
  /** `native`; `evm` (ERC-20 `0x…`); `hash20` (Solana SPL: hex(keccak256(mint)[12..32])). */
  readonly kind: "native" | "evm" | "hash20";
  readonly token: string | null;
}

export function parseOmftAssetId(assetId: string): OmftAsset | null {
  const m = /^nep141:([a-z0-9]+)(?:-(0x[0-9a-f]{40}|[0-9a-f]{40}))?\.omft\.near$/.exec(assetId);
  if (!m) return null;
  const blockchain = m[1] as string;
  const token = m[2] ?? null;
  if (token === null) return { blockchain, kind: "native", token: null };
  return { blockchain, kind: token.startsWith("0x") ? "evm" : "hash20", token };
}
