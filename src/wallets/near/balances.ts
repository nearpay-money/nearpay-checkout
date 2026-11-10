/**
 * NEAR balance and gas-price reads for the token picker and the network-fee pre-check (lazy chunks
 * only): NEP-141 `ft_balance_of`, NEAR Intents `mt_balance_of`, the spendable native balance and the
 * gas price, through the configured NEAR RPC (already in the CSP).
 */
import { type FetchLike, nearRpc, viewFunction } from "./rpc";

const BASE_UNITS = /^(0|[1-9][0-9]{0,77})$/;

function units(v: unknown, what: string): string {
  if (typeof v !== "string" || !BASE_UNITS.test(v)) throw new Error(`unexpected ${what}`);
  return v;
}

/** NEP-141 balance of `account` on `token` (base units). */
export async function ftBalanceOf(rpc: string, token: string, account: string, f?: FetchLike): Promise<string> {
  return units(await viewFunction<unknown>(rpc, token, "ft_balance_of", { account_id: account }, f), "ft_balance_of");
}

/** NEAR Intents (NEP-245) balance of `account` for `tokenId` (e.g. `nep141:usdc.near`) on `intents`. */
export async function mtBalanceOf(
  rpc: string,
  intents: string,
  account: string,
  tokenId: string,
  f?: FetchLike,
): Promise<string> {
  return units(
    await viewFunction<unknown>(rpc, intents, "mt_balance_of", { account_id: account, token_id: tokenId }, f),
    "mt_balance_of",
  );
}

/** yoctoNEAR locked per byte of account storage (protocol storage price, 1 NEAR per 100 kB). */
export const STORAGE_PRICE_PER_BYTE = 10_000_000_000_000_000_000n;

/** Spendable native balance (yoctoNEAR): `amount` minus what the account's storage locks. */
export async function availableNear(
  rpc: string,
  account: string,
  doFetch: FetchLike = (...a) => fetch(...a),
): Promise<string> {
  const r = await nearRpc<{ amount?: unknown; storage_usage?: unknown }>(
    rpc,
    "query",
    { request_type: "view_account", finality: "final", account_id: account },
    doFetch,
  );
  const amount = BigInt(units(r.amount, "account amount"));
  const usage = r.storage_usage;
  if (typeof usage !== "number" || !Number.isSafeInteger(usage) || usage < 0)
    throw new Error("unexpected storage_usage");
  const free = amount - BigInt(usage) * STORAGE_PRICE_PER_BYTE;
  return (free > 0n ? free : 0n).toString();
}

/** Current gas price (yoctoNEAR per gas unit). */
export async function gasPrice(rpc: string, doFetch: FetchLike = (...a) => fetch(...a)): Promise<string> {
  const r = await nearRpc<{ gas_price?: unknown }>(rpc, "gas_price", [null], doFetch);
  return units(r.gas_price, "gas_price");
}
