/** Which payment options a path can use (lld/checkout-and-js.md §3 `asset-picker`), search and network filter. */
import type { Option, Path } from "../../app/machine";
import { chainName, walletAsset } from "../../lib/chains/chains";
import { parseOmftAssetId, SOLANA_MAINNET } from "../../lib/spec-gap-0.4.0";

/** Wallet recipe of an option: derived from the attested asset id, else its typed token (CR-15-06). */
export const optionWalletAsset = (o: Option) => walletAsset(o.origin_asset_id, o.chain, o.token);

/**
 * Solana wallet candidates (§11): route quotes on Solana for SOL or an SPL omft asset. Only a hint for
 * the list — the recipe is decided from the verified attestation (`solanaRecipe`), never from the option.
 */
export function isSolanaWalletOption(o: Option): boolean {
  if (o.method !== "route_quote" || o.chain !== SOLANA_MAINNET) return false;
  const a = parseOmftAssetId(o.origin_asset_id);
  return a !== null && a.blockchain === "sol" && (a.kind === "native" || a.kind === "hash20");
}

export function payableOptions(
  options: readonly Option[],
  path: Path,
  family: "evm" | "near" | "solana" | null,
): Option[] {
  const list = options.filter((o) => {
    if (path === "manual") return o.method === "route_quote";
    // Intents transfers are signed with NEP-413 (NEAR) or ERC-191 (EVM); Solana wallets can't sign them.
    if (o.method === "intents_transfer") return family === "evm" || family === "near";
    if (family === "solana") return isSolanaWalletOption(o);
    const asset = optionWalletAsset(o);
    if (!asset) return false;
    return family === "evm"
      ? asset.kind.startsWith("evm_")
      : family === "near"
        ? asset.kind.startsWith("near_")
        : false;
  });
  // Server order is "best first"; keep it, but put usable options before unavailable ones.
  return [...list.filter((o) => o.available), ...list.filter((o) => !o.available)];
}

/** Stable key of an option (the same asset can be offered by both methods). */
export const optionKey = (o: Option): string => `${o.method}:${o.origin_asset_id}:${o.chain}`;

/** Network label of an option ("Base", or "NEAR Intents" for balance transfers). */
export function optionNetwork(o: Option): string {
  return o.method === "intents_transfer" ? "NEAR Intents" : chainName(o.chain);
}

/** "USDC · Base" — full token and network identity (design-system §1.3). */
export const optionTitle = (o: Option): string => `${o.symbol} · ${optionNetwork(o)}`;

/** Filter key of an option's network (intents transfers are their own network). */
export const networkKey = (o: Option): string => (o.method === "intents_transfer" ? "intents" : o.chain);

export interface NetworkChoice {
  readonly key: string;
  readonly label: string;
}

/** Networks present in the option list, in first-seen order (the server ranks options best first). */
export function networksOf(options: readonly Option[]): NetworkChoice[] {
  const seen = new Map<string, string>();
  for (const o of options) if (!seen.has(networkKey(o))) seen.set(networkKey(o), optionNetwork(o));
  return [...seen].map(([key, label]) => ({ key, label }));
}

const norm = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/**
 * Search ("Search token or network") and network filter. Every query word must match the symbol or the
 * network name; "on" is ignored so "DOGE on Base" works like the Figma example.
 */
export function filterOptions(options: readonly Option[], query: string, network: string | null): Option[] {
  const words = norm(query)
    .split(/[\s·,/]+/)
    .filter((w) => w && w !== "on");
  return options.filter((o) => {
    if (network !== null && networkKey(o) !== network) return false;
    if (words.length === 0) return true;
    const hay = norm(`${o.symbol} ${optionNetwork(o)} ${o.chain}`);
    return words.every((w) => hay.includes(w));
  });
}
