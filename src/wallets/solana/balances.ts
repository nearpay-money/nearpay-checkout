/**
 * Solana balance reads for the token picker and the network-fee pre-check (lazy chunks only): the
 * payer's SOL balance and classic-Token balances by mint, through the configured Solana RPC.
 */
import { rpc } from "./rpc";
import { TOKEN_PROGRAM } from "./tx";

/** Lamports as a decimal string (JSON numbers above 2^53 would be imprecise: refused). */
function lamports(v: unknown, what: string): string {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
    throw new Error(`Solana RPC returned a malformed ${what}`);
  return String(v);
}

/** SOL balance of `owner` (lamports). */
export async function solBalance(url: string, owner: string): Promise<string> {
  const r = await rpc<{ value?: unknown }>(url, "getBalance", [owner, { commitment: "confirmed" }]);
  return lamports(r.value, "balance");
}

const UNITS = /^(0|[1-9][0-9]{0,77})$/;

/**
 * Classic-Token balances of `owner`, summed by mint (base units). One `getTokenAccountsByOwner` call
 * over the Token program (`jsonParsed`); Token-2022 accounts are not read (those mints stay manual-path).
 */
export async function splBalances(url: string, owner: string): Promise<Map<string, string>> {
  const r = await rpc<{ value?: unknown }>(url, "getTokenAccountsByOwner", [
    owner,
    { programId: TOKEN_PROGRAM },
    { encoding: "jsonParsed", commitment: "confirmed" },
  ]);
  if (!Array.isArray(r.value)) throw new Error("Solana RPC returned malformed token accounts");
  const sums = new Map<string, bigint>();
  for (const a of r.value as { account?: { data?: { parsed?: { info?: unknown } } } }[]) {
    const info = a?.account?.data?.parsed?.info as { mint?: unknown; tokenAmount?: { amount?: unknown } } | undefined;
    const mint = info?.mint;
    const amount = info?.tokenAmount?.amount;
    if (typeof mint !== "string" || typeof amount !== "string" || !UNITS.test(amount)) {
      throw new Error("Solana RPC returned a malformed token account");
    }
    sums.set(mint, (sums.get(mint) ?? 0n) + BigInt(amount));
  }
  return new Map([...sums].map(([m, v]) => [m, v.toString()]));
}
