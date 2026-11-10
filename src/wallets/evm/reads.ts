/**
 * Read-only EVM calls made through the connected wallet's own EIP-1193 provider (no RPC host is added
 * to the CSP): the chain the wallet is on, token and native balances for the token picker, and the
 * gas estimate + fee data for the network-fee pre-check. Amounts are bigint base units (INV-5).
 */
import type { Eip1193Provider } from "./provider";

/** `balanceOf(address)` selector. */
export const ERC20_BALANCE_OF = "0x70a08231";
/** OP-stack GasPriceOracle predeploy and its `getL1FeeUpperBound(uint256)` selector (Fjord+). */
export const OP_GAS_ORACLE = "0x420000000000000000000000000000000000000f";
export const L1_FEE_UPPER_BOUND = "0xf1c7a58b";
/** Chains whose fee has an L1 data part not covered by `eth_estimateGas` × gas price (Base, OP Mainnet). */
export const OP_STACK_CHAIN_IDS: ReadonlySet<number> = new Set([8453, 10]);

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const QTY = /^0x[0-9a-fA-F]{1,64}$/;

/** A JSON-RPC quantity / uint256 return value as bigint (`"0x"` is zero, as some nodes answer for empty data). */
export function hexToBigint(v: unknown, what: string): bigint {
  if (v === "0x") return 0n;
  if (typeof v !== "string" || !QTY.test(v)) throw new Error(`unexpected ${what}`);
  return BigInt(v);
}

const word = (hex: string): string => hex.padStart(64, "0");

async function call(p: Eip1193Provider, method: string, params: unknown[]): Promise<unknown> {
  return p.request({ method, params });
}

/** Chain id the wallet is on (no prompt). */
export async function walletChainId(p: Eip1193Provider): Promise<number> {
  const id = hexToBigint(await p.request({ method: "eth_chainId" }), "eth_chainId");
  if (id > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("unexpected eth_chainId");
  return Number(id);
}

export async function erc20BalanceOf(p: Eip1193Provider, token: string, owner: string): Promise<bigint> {
  if (!ADDR.test(token) || !ADDR.test(owner)) throw new RangeError("not an EVM address");
  const data = `${ERC20_BALANCE_OF}${word(owner.slice(2).toLowerCase())}`;
  return hexToBigint(await call(p, "eth_call", [{ to: token, data }, "latest"]), "balanceOf");
}

export async function nativeBalance(p: Eip1193Provider, owner: string): Promise<bigint> {
  if (!ADDR.test(owner)) throw new RangeError("not an EVM address");
  return hexToBigint(await call(p, "eth_getBalance", [owner, "latest"]), "eth_getBalance");
}

export interface FeeTx {
  readonly from: string;
  readonly to: string;
  readonly value: string;
  readonly data?: string;
}

/** Gas-limit margin over `eth_estimateGas` (6/5 = +20 %). */
export const GAS_MARGIN = [6n, 5n] as const;
/** Assumed size of the signed transfer for the OP-stack L1 fee upper bound (bytes; an ERC-20 transfer is ~110). */
export const L1_TX_SIZE = 200n;

/**
 * Worst-case native cost of the network fee of `tx`, in wei: gas estimate +20 % times the higher of
 * `eth_gasPrice` and `2 × baseFee + priority fee` (what EIP-1559 wallets reserve as max fee), plus
 * the L1 data-fee upper bound on OP-stack chains. The value transferred is not part of it; the
 * estimate runs with `value: 0x0` so a short native balance can't make it revert.
 */
export async function networkFee(p: Eip1193Provider, tx: FeeTx, chainId: number): Promise<bigint> {
  const estTx = { ...tx, value: "0x0" };
  const [gasRaw, priceRaw, block, prio] = await Promise.all([
    call(p, "eth_estimateGas", [estTx]),
    call(p, "eth_gasPrice", []),
    call(p, "eth_getBlockByNumber", ["latest", false]).catch(() => null),
    call(p, "eth_maxPriorityFeePerGas", []).catch(() => null),
  ]);
  const gas = (hexToBigint(gasRaw, "eth_estimateGas") * GAS_MARGIN[0] + GAS_MARGIN[1] - 1n) / GAS_MARGIN[1];
  const gasPrice = hexToBigint(priceRaw, "eth_gasPrice");
  let perGas = gasPrice;
  const base = (block as { baseFeePerGas?: unknown } | null)?.baseFeePerGas;
  if (typeof base === "string" && QTY.test(base)) {
    const tip = typeof prio === "string" && QTY.test(prio) ? BigInt(prio) : 0n;
    const eip1559 = BigInt(base) * 2n + tip;
    if (eip1559 > perGas) perGas = eip1559;
  }
  let fee = gas * perGas;
  if (OP_STACK_CHAIN_IDS.has(chainId)) {
    try {
      const data = `${L1_FEE_UPPER_BOUND}${word(L1_TX_SIZE.toString(16))}`;
      fee += hexToBigint(await call(p, "eth_call", [{ to: OP_GAS_ORACLE, data }, "latest"]), "getL1FeeUpperBound");
    } catch {
      /* pre-Fjord oracle or no oracle: the execution fee alone */
    }
  }
  return fee;
}
