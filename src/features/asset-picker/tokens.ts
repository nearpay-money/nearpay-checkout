/**
 * Token picker logic (pure): which on-chain balance answers "can this wallet pay with this option",
 * the rows the picker shows (only tokens the connected wallet holds, by value, "Not enough" below
 * the indicative amount), and balance formatting. Amounts stay bigint / base-unit strings (INV-5).
 *
 * Balances are display hints only: they never feed a money path (the wallet transfer is built from
 * the verified attestation, §5.4), so an unreadable or wrong balance can only change what is listed.
 */

import { parseOmftAssetId } from "@nearpay-money/spec";
import type { Option } from "../../app/machine";
import { formatBaseUnits, formatSignificant } from "../../lib/money/format";
import { isSolanaWalletOption, optionKey, optionWalletAsset } from "./options";

export type WalletFamily = "evm" | "near" | "solana";

export type BalanceTarget =
  | { readonly kind: "erc20"; readonly chainId: number; readonly token: string }
  | { readonly kind: "evm_native"; readonly chainId: number }
  | { readonly kind: "nep141"; readonly token: string }
  /** wNEAR is paid from native NEAR (`near_deposit` + transfer), so the native balance counts. */
  | { readonly kind: "near_native" }
  | { readonly kind: "intents"; readonly tokenId: string }
  | { readonly kind: "sol" }
  | { readonly kind: "spl"; readonly mint: string };

const BASE58_32 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The balance to read for an option paid from a `family` wallet; null when it can't be read here. */
export function balanceTarget(o: Option, family: WalletFamily): BalanceTarget | null {
  if (o.method === "intents_transfer") {
    return family === "solana" ? null : { kind: "intents", tokenId: o.origin_asset_id };
  }
  if (family === "solana") {
    if (!isSolanaWalletOption(o)) return null;
    if (parseOmftAssetId(o.origin_asset_id)?.kind === "native") return { kind: "sol" };
    const mint = o.token?.standard === "spl" ? o.token.address : null;
    return mint && BASE58_32.test(mint) ? { kind: "spl", mint } : null;
  }
  const a = optionWalletAsset(o);
  if (!a) return null;
  if (family === "evm") {
    if (a.kind === "evm_erc20") return { kind: "erc20", chainId: a.chainId, token: a.token };
    if (a.kind === "evm_native") return { kind: "evm_native", chainId: a.chainId };
    return null;
  }
  if (a.kind === "near_nep141") return { kind: "nep141", token: a.token };
  if (a.kind === "near_wrap") return { kind: "near_native" };
  return null;
}

/**
 * Balances by option key (base units). `null` = the read failed for that option (balance unknown — the
 * token stays listed and selectable); options without a readable balance here are absent.
 */
export type Balances = ReadonlyMap<string, string | null>;

/** Outcome of reading the connected wallet's balances for one network's options. */
export type BalanceRead =
  | { readonly state: "ok"; readonly balances: Balances }
  /** EVM wallet on another chain: reading needs a switch first (the provider answers for its current chain). */
  | { readonly state: "wrong_chain"; readonly chain: string }
  /** Nothing readable for this wallet and network (e.g. no wallet recipe). */
  | { readonly state: "none" };

export interface TokenRow {
  readonly option: Option;
  /** Wallet balance, when read. */
  readonly balance: string | null;
  /** The balance read failed for this option ("Balance unavailable"; still selectable). */
  readonly unavailable: boolean;
  /** Balance below the indicative amount of this payment (only when that amount is known). */
  readonly short: boolean;
}

const cmp = (a: bigint, b: bigint): number => (a > b ? -1 : a < b ? 1 : 0);

/**
 * Value order of two held tokens: by how much of this payment the balance covers
 * (`balance / estimated_amount_in`, compared by cross-multiplication) when both estimates are known —
 * the quote data prices every token against the same payment — otherwise by the decimal balance.
 */
function byValue(a: TokenRow, b: TokenRow): number {
  const ba = BigInt(a.balance ?? "0");
  const bb = BigInt(b.balance ?? "0");
  const ea = a.option.estimated_amount_in;
  const eb = b.option.estimated_amount_in;
  if (ea && eb && ea !== "0" && eb !== "0") return cmp(ba * BigInt(eb), bb * BigInt(ea));
  return cmp(ba * 10n ** BigInt(b.option.decimals), bb * 10n ** BigInt(a.option.decimals));
}

function row(o: Option, balances: Balances | null): TokenRow {
  const key = optionKey(o);
  const balance = balances?.get(key) ?? null;
  const est = o.estimated_amount_in;
  return {
    option: o,
    balance,
    unavailable: balances?.has(key) === true && balance === null,
    short: balance !== null && est !== null && BigInt(balance) < BigInt(est),
  };
}

/**
 * Rows of the token picker for one network's options (server order = best first).
 *
 * - No balances (no wallet, manual path, test mode, read failed) or `showAll`: every option, in server
 *   order, with the balance where it is known.
 * - Balances: only options whose balance is > 0 or unknown (no readable balance, or the read failed —
 *   never hidden as if empty), usable ones first, then those the balance doesn't cover ("Not enough"),
 *   each group by value; unknown balances after the known ones, in server order.
 */
export function tokenRows(options: readonly Option[], balances: Balances | null, showAll: boolean): TokenRow[] {
  const rows = options.map((o) => row(o, balances));
  if (!balances || showAll) return rows;
  const rank = (r: TokenRow): number => (!r.option.available ? 2 : r.short ? 1 : 0);
  return rows
    .filter((r) => r.balance === null || BigInt(r.balance) > 0n)
    .map((r, i) => ({ r, i }))
    .sort((x, y) => {
      const k = rank(x.r) - rank(y.r);
      if (k !== 0) return k;
      // Options whose balance couldn't be read go after the held ones, in server order.
      const ux = x.r.balance === null ? 1 : 0;
      const uy = y.r.balance === null ? 1 : 0;
      if (ux !== uy) return ux - uy;
      return (ux === 0 ? byValue(x.r, y.r) : 0) || x.i - y.i;
    })
    .map(({ r }) => r);
}

/** Whether a row can be picked (available route, balance not known to be short). */
export const rowSelectable = (r: TokenRow): boolean => r.option.available && !r.short;

/** Smallest balance shown as a number: below it, "< 0.000001" (fraction digits of the dust floor). */
export const DUST_DIGITS = 6;

/**
 * Balance for display: at most 6 significant digits, rounded DOWN (never overstated) — "0.00156285",
 * "4.52101", "1,234.56" — and "< 0.000001" for dust. Exact bigint/string arithmetic.
 */
export function formatBalance(amount: string, decimals: number): string {
  const floor = Math.min(decimals, DUST_DIGITS);
  const v = BigInt(amount);
  if (v > 0n && v < 10n ** BigInt(decimals - floor)) return `< ${formatBaseUnits("1", floor, floor)}`;
  return formatSignificant(amount, decimals, "floor");
}

/**
 * An amount the payer needs or will send, for display with its symbol: at most 6 significant digits,
 * rounded UP (never understated) — "0.000481721 ETH", "1.52 USDC".
 */
export function formatNeeded(amount: string, decimals: number, symbol: string): string {
  return `${formatSignificant(amount, decimals, "ceil")} ${symbol}`;
}
