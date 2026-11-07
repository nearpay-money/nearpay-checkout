/**
 * Chains the checkout can name and (for EVM/NEAR) pay on. CAIP-2 ids as in `@nearpay/spec`; the list
 * mirrors the kit chain registry (lld/00-foundations.md §4) for display, address validation and the
 * wallet path. Unknown chains still work on the manual path (generic name, no validation shortcuts).
 */
export type ChainFamily = "evm" | "near" | "solana" | "bitcoin";

export interface ChainInfo {
  readonly caip2: string;
  readonly name: string;
  readonly family: ChainFamily;
  readonly nativeSymbol: string;
  readonly nativeDecimals: number;
  readonly evmChainId?: number;
  /** `wallet_addEthereumChain` parameters (public RPC + explorer) for wallets that lack the chain. */
  readonly evmAdd?: { readonly rpcUrls: readonly string[]; readonly blockExplorerUrls: readonly string[] };
  readonly btc?: { readonly hrp: string; readonly p2pkh: number; readonly p2sh: number };
  /** omft bridge prefix (`nep141:<prefix>-0x….omft.near` tokens, `nep141:<prefix>.omft.near` native). */
  readonly omft?: string;
}

const evm = (id: number, name: string, native: string, rpc: string, explorer: string, omft?: string): ChainInfo => ({
  caip2: `eip155:${id}`,
  name,
  family: "evm",
  nativeSymbol: native,
  nativeDecimals: 18,
  evmChainId: id,
  evmAdd: { rpcUrls: [rpc], blockExplorerUrls: [explorer] },
  ...(omft ? { omft } : {}),
});

export const NEAR_MAINNET = "near:mainnet";

export const CHAINS: readonly ChainInfo[] = Object.freeze([
  { caip2: NEAR_MAINNET, name: "NEAR", family: "near", nativeSymbol: "NEAR", nativeDecimals: 24 },
  evm(1, "Ethereum", "ETH", "https://ethereum-rpc.publicnode.com", "https://etherscan.io", "eth"),
  evm(8453, "Base", "ETH", "https://mainnet.base.org", "https://basescan.org", "base"),
  evm(42161, "Arbitrum One", "ETH", "https://arb1.arbitrum.io/rpc", "https://arbiscan.io", "arb"),
  evm(10, "OP Mainnet", "ETH", "https://mainnet.optimism.io", "https://optimistic.etherscan.io"),
  evm(137, "Polygon", "POL", "https://polygon-rpc.com", "https://polygonscan.com"),
  evm(56, "BNB Smart Chain", "BNB", "https://bsc-dataseed.binance.org", "https://bscscan.com"),
  evm(43114, "Avalanche C-Chain", "AVAX", "https://api.avax.network/ext/bc/C/rpc", "https://snowtrace.io"),
  evm(100, "Gnosis", "XDAI", "https://rpc.gnosischain.com", "https://gnosisscan.io", "gnosis"),
  {
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    name: "Solana",
    family: "solana",
    nativeSymbol: "SOL",
    nativeDecimals: 9,
  },
  {
    caip2: "bip122:000000000019d6689c085ae165831e93",
    name: "Bitcoin",
    family: "bitcoin",
    nativeSymbol: "BTC",
    nativeDecimals: 8,
    btc: { hrp: "bc", p2pkh: 0x00, p2sh: 0x05 },
  },
  {
    caip2: "bip122:12a765e31ffd4059bada1e25190f6e98",
    name: "Litecoin",
    family: "bitcoin",
    nativeSymbol: "LTC",
    nativeDecimals: 8,
    btc: { hrp: "ltc", p2pkh: 0x30, p2sh: 0x32 },
  },
  {
    caip2: "bip122:1a91e3dace36e2be3bf030a65679fe82",
    name: "Dogecoin",
    family: "bitcoin",
    nativeSymbol: "DOGE",
    nativeDecimals: 8,
    btc: { hrp: "", p2pkh: 0x1e, p2sh: 0x16 },
  },
]);

const BY_CAIP2 = new Map(CHAINS.map((c) => [c.caip2, c]));

export function getChain(caip2: string): ChainInfo | undefined {
  return BY_CAIP2.get(caip2);
}

/** Human name of a chain; unknown chains show their CAIP-2 id (never guessed). */
export function chainName(caip2: string): string {
  return getChain(caip2)?.name ?? caip2;
}

export function chainFamily(caip2: string): ChainFamily | null {
  return getChain(caip2)?.family ?? null;
}

/** How the wallet path pays an origin asset (null → manual path only). */
export type WalletAsset =
  | { readonly kind: "evm_erc20"; readonly chainId: number; readonly token: string }
  | { readonly kind: "evm_native"; readonly chainId: number }
  | { readonly kind: "near_nep141"; readonly token: string }
  | { readonly kind: "near_wrap"; readonly token: "wrap.near" };

const OMFT_RE = /^nep141:([a-z0-9]+)(?:-(0x[0-9a-f]{40}))?\.omft\.near$/;
const NEP141_RE = /^nep141:((?:(?:[a-z\d]+[-_])*[a-z\d]+\.)*(?:[a-z\d]+[-_])*[a-z\d]+)$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const NEAR_ACCOUNT_RE = /^(?:(?:[a-z\d]+[-_])*[a-z\d]+\.)*(?:[a-z\d]+[-_])*[a-z\d]+$/;

/**
 * Token contract of a payment option (`PaymentOption.token`, spec 0.2.0, CR-15-06). `undefined` = the
 * server predates the field; `null` = the server knows no wallet recipe (manual path only).
 */
export interface TokenHint {
  readonly standard: string;
  readonly address: string | null;
}

/** Derivation from the asset id alone (omft-bridged EVM assets, NEP-141 accounts). */
function derivedWalletAsset(assetId: string, info: ChainInfo): WalletAsset | null {
  if (info.family === "evm") {
    const m = OMFT_RE.exec(assetId);
    if (!m || !info.omft || m[1] !== info.omft || info.evmChainId === undefined) return null;
    return m[2]
      ? { kind: "evm_erc20", chainId: info.evmChainId, token: m[2] }
      : { kind: "evm_native", chainId: info.evmChainId };
  }
  if (info.family === "near") {
    const m = NEP141_RE.exec(assetId);
    if (!m || assetId.endsWith(".omft.near")) return null;
    const token = m[1] as string;
    if (token.length < 2 || token.length > 64) return null;
    return token === "wrap.near" ? { kind: "near_wrap", token } : { kind: "near_nep141", token };
  }
  return null;
}

/** Wallet recipe from a typed token contract (only standards with a transfer the checkout builds). */
function hintedWalletAsset(token: TokenHint, info: ChainInfo): WalletAsset | null {
  if (info.family === "evm" && info.evmChainId !== undefined) {
    if (token.standard === "native" && token.address === null) return { kind: "evm_native", chainId: info.evmChainId };
    if (token.standard === "erc20" && token.address !== null && EVM_ADDRESS_RE.test(token.address)) {
      return { kind: "evm_erc20", chainId: info.evmChainId, token: token.address.toLowerCase() };
    }
    return null;
  }
  if (info.family === "near" && token.standard === "nep141" && token.address !== null) {
    const a = token.address;
    if (a.length < 2 || a.length > 64 || !NEAR_ACCOUNT_RE.test(a)) return null;
    return a === "wrap.near" ? { kind: "near_wrap", token: "wrap.near" } : { kind: "near_nep141", token: a };
  }
  return null;
}

const sameAsset = (a: WalletAsset, b: WalletAsset): boolean =>
  a.kind === b.kind &&
  ("token" in a ? a.token.toLowerCase() : "") === ("token" in b ? b.token.toLowerCase() : "") &&
  ("chainId" in a ? a.chainId : 0) === ("chainId" in b ? b.chainId : 0);

/**
 * How the wallet path pays an origin asset on `chain`.
 *
 * - The asset id is attested (sentinel signs `origin_asset_id`), so a recipe derived from it wins:
 *   omft-bridged EVM assets (`<prefix>-0x<contract>.omft.near`, prefix of `chain`) and NEP-141 token
 *   accounts (`wrap.near` is paid from native NEAR).
 * - Otherwise the typed `token` of the payment option (CR-15-06) is used: `erc20` / `native` on EVM
 *   chains, `nep141` on NEAR. `spl`, `other` and unknown standards stay manual-path only.
 * - A `token` that contradicts the derivable recipe disables the wallet path (fail closed).
 * - `token` null or absent (older servers): only the derived recipe applies.
 */
export function walletAsset(assetId: string, chain: string, token?: TokenHint | null): WalletAsset | null {
  const info = getChain(chain);
  if (!info) return null;
  const derived = derivedWalletAsset(assetId, info);
  if (token === undefined || token === null) return derived;
  const hinted = hintedWalletAsset(token, info);
  if (derived) return hinted && sameAsset(derived, hinted) ? derived : null;
  return hinted;
}
