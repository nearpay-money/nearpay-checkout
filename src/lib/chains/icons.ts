/**
 * Which bundled logo (src/assets/crypto/, from `@web3icons/core`, scripts/sync-crypto-icons.mjs) names a chain
 * or a token. Pure: the UI turns the name into a self-hosted asset URL (`ui/CryptoIcon.tsx`); a null name
 * means "no logo" and the letter avatar is shown instead (never a guessed or remote image).
 */

/** Chain (CAIP-2) → icon file name. NEAR Intents balances show the NEAR logo. */
const CHAIN_ICONS: Readonly<Record<string, string>> = {
  "near:mainnet": "chain-near",
  "eip155:1": "chain-ethereum",
  "eip155:8453": "chain-base",
  "eip155:42161": "chain-arbitrum",
  "eip155:10": "chain-optimism",
  "eip155:137": "chain-polygon",
  "eip155:56": "chain-bnb",
  "eip155:43114": "chain-avalanche",
  "eip155:100": "chain-gnosis",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "chain-solana",
  "bip122:000000000019d6689c085ae165831e93": "chain-bitcoin",
  "bip122:12a765e31ffd4059bada1e25190f6e98": "chain-litecoin",
  // The set has no Dogecoin network logo; the coin's own logo stands for its chain.
  "bip122:1a91e3dace36e2be3bf030a65679fe82": "token-doge",
};

/** Network key of NEAR Intents balance transfers (`features/asset-picker/options.ts` INTENTS_NETWORK). */
const INTENTS = "intents";

/** Token symbols with a bundled logo (file `token-<symbol>.svg`). */
const TOKENS: ReadonlySet<string> = new Set([
  "USDC",
  "USDT",
  "ETH",
  "SOL",
  "BTC",
  "NEAR",
  "DAI",
  "WBTC",
  "POL",
  "BNB",
  "AVAX",
  "LTC",
  "DOGE",
  "OP",
  "GNO",
  "ARB",
]);

/** Wrapped or renamed tokens shown with the logo of the asset they stand for. */
const TOKEN_ALIASES: Readonly<Record<string, string>> = {
  WNEAR: "NEAR",
  WETH: "ETH",
  MATIC: "POL",
};

/** Icon name of a chain (CAIP-2 id, or the NEAR Intents network key); null → letter avatar. */
export function chainIconName(chain: string): string | null {
  if (chain === INTENTS) return "chain-near";
  return CHAIN_ICONS[chain] ?? null;
}

/** Icon name of a token symbol (case-insensitive, exact symbol or a known alias); null → letter avatar. */
export function tokenIconName(symbol: string): string | null {
  const s = symbol.trim().toUpperCase();
  const sym = TOKEN_ALIASES[s] ?? s;
  return TOKENS.has(sym) ? `token-${sym.toLowerCase()}` : null;
}

/** Every icon name the mappings can return (the bundled files must cover them; unit-tested). */
export function allIconNames(): string[] {
  return [...new Set([...Object.values(CHAIN_ICONS), ...[...TOKENS].map((s) => `token-${s.toLowerCase()}`)])];
}
