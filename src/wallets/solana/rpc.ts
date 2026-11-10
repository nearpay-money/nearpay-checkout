/**
 * Solana JSON-RPC reads for the wallet path (lld/checkout-and-js.md §11, `VITE_SOLANA_RPC_URL`):
 * recent blockhash, the mint's owner program (classic Token vs Token-2022) and whether the deposit's
 * token account exists (its rent is part of the network-fee note). Balance reads are in `balances.ts`.
 */
import bs58 from "bs58";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./tx";

/** Rent-exempt minimum of a 165-byte token account (lamports), used when the RPC can't say. */
export const ATA_RENT_FALLBACK = "2039280";

export async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
  });
  if (!res.ok) throw new Error(`Solana RPC ${method} failed (${res.status})`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error || !("result" in body)) throw new Error(`Solana RPC ${method}: ${body.error?.message ?? "no result"}`);
  return body.result as T;
}

export async function latestBlockhash(url: string): Promise<string> {
  const r = await rpc<{ value?: { blockhash?: unknown } }>(url, "getLatestBlockhash", [{ commitment: "confirmed" }]);
  const h = r.value?.blockhash;
  if (typeof h !== "string" || bs58.decode(h).length !== 32) throw new Error("Solana RPC returned no blockhash");
  return h;
}

/** Owner program of an account; null when the account does not exist. */
export async function accountOwner(url: string, address: string): Promise<string | null> {
  const r = await rpc<{ value: { owner?: unknown } | null }>(url, "getAccountInfo", [
    address,
    { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 0 } },
  ]);
  if (r.value === null) return null;
  if (typeof r.value.owner !== "string") throw new Error("Solana RPC returned a malformed account");
  return r.value.owner;
}

export type MintProgram = "token" | "token_2022" | "unknown";

export async function mintProgram(url: string, mint: string): Promise<MintProgram> {
  const owner = await accountOwner(url, mint);
  return owner === TOKEN_PROGRAM ? "token" : owner === TOKEN_2022_PROGRAM ? "token_2022" : "unknown";
}

export async function tokenAccountRent(url: string): Promise<string> {
  try {
    const v = await rpc<unknown>(url, "getMinimumBalanceForRentExemption", [165]);
    return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? String(v) : ATA_RENT_FALLBACK;
  } catch {
    return ATA_RENT_FALLBACK;
  }
}
