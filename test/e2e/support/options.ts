/** Payment options and wallet balances for the "Pay with" dropdown tests and screenshots. */
import { USDC_BASE } from "../../support/sessions";
import type { EvmReads } from "./wallets";

export const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const USDT = "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2";
export const DAI = "0x50c5725949a6f0c72e6c4a641f24049a917db0cb";
export const omft = (addr: string) => `nep141:base-${addr}.omft.near`;
export const ETH_BASE = "nep141:base.omft.near";

export const opt = (
  asset: string,
  chain: string,
  symbol: string,
  decimals: number,
  amount: string,
  extra: object = {},
) => ({
  method: "route_quote",
  origin_asset_id: asset,
  chain,
  symbol,
  decimals,
  estimated_amount_in: amount,
  route_class: "stable_pair",
  min_deadline_s: 300,
  available: true,
  reason: null,
  ...extra,
});

/** Base tokens: USDC, USDT, DAI (18 decimals) and native ETH, plus 11 more networks (manual path). */
export const BASE_OPTIONS = [
  opt(USDC_BASE, "eip155:8453", "USDC", 6, "2005013"),
  opt(omft(USDT), "eip155:8453", "USDT", 6, "2004000"),
  opt(omft(DAI), "eip155:8453", "DAI", 18, "2003000000000000000"),
  opt(ETH_BASE, "eip155:8453", "ETH", 18, "600000000000000"),
];
const MORE_NETWORKS: [string, string][] = [
  ["eip155:1", "nep141:eth.omft.near"],
  ["eip155:42161", "nep141:arb.omft.near"],
  ["eip155:10", "nep141:op.omft.near"],
  ["eip155:137", "nep141:pol.omft.near"],
  ["eip155:56", "nep141:bsc.omft.near"],
  ["eip155:43114", "nep141:avax.omft.near"],
  ["eip155:100", "nep141:gnosis.omft.near"],
  ["near:mainnet", "nep141:wrap.near"],
  ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "nep141:sol.omft.near"],
  ["bip122:000000000019d6689c085ae165831e93", "nep141:btc.omft.near"],
  ["bip122:1a91e3dace36e2be3bf030a65679fe82", "nep141:doge.omft.near"],
];
export const MANY = [...BASE_OPTIONS, ...MORE_NETWORKS.map(([chain, asset]) => opt(asset, chain, "COIN", 8, "100000"))];

export const hex = (n: bigint) => `0x${n.toString(16)}`;
/** USDC 12.34, USDT 0, DAI 1.5 (below 2.003), ETH 0.001 — gas cheap. */
export const RICH: EvmReads = {
  native: hex(1_000_000_000_000_000n),
  tokens: { [USDC]: hex(12_340_000n), [USDT]: "0x0", [DAI]: hex(1_500_000_000_000_000_000n) },
  gas: { estimate: hex(65_000n), price: hex(10_000_000n), baseFee: hex(5_000_000n), l1Fee: hex(1_000_000_000n) },
};

/**
 * Live-beta regression (MetaMask on Base): 4.521015 USDC and 0.001562859786699476 ETH in the wallet,
 * dust in its NEAR Intents balance; the server lists the ETH Intents transfer first, as rails does.
 */
export const PROD_PAYER_READS: EvmReads = {
  native: "0x58d69a66b82d4", // 1562859786699476 wei
  tokens: { [USDC]: `0x${"44fc37".padStart(64, "0")}` }, // 4521015, a full 32-byte word as nodes answer
  gas: { estimate: hex(65_000n), price: hex(10_000_000n), baseFee: hex(5_000_000n), l1Fee: hex(1_000_000_000n) },
};
export const PROD_NEEDED_ETH = "481720114165824";
export const PROD_OPTIONS = [
  opt(ETH_BASE, "near:mainnet", "ETH", 18, PROD_NEEDED_ETH, {
    method: "intents_transfer",
    route_class: "intents_transfer",
    token: null,
  }),
  opt(omft(USDC), "eip155:8453", "USDC", 6, "1520000", {
    token: { standard: "erc20", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  }),
  opt(ETH_BASE, "eip155:8453", "ETH", 18, PROD_NEEDED_ETH, {
    route_class: "same_asset",
    token: { standard: "native", address: null },
  }),
];
