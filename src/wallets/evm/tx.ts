/**
 * EVM transfers built inside the checkout (lld/checkout-and-js.md §5.4): ERC-20
 * `transfer(depositAddress, amount_in)` on the token contract, or a plain value transfer for the
 * native asset. Inputs are the ATTESTED instructions only.
 */
import type { WalletAsset } from "../../lib/chains/chains";

/** `transfer(address,uint256)` selector. */
export const ERC20_TRANSFER = "0xa9059cbb";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const MAX_UINT256 = (1n << 256n) - 1n;

function word(hex: string): string {
  return hex.padStart(64, "0");
}

export function uintHex(amount: string): string {
  if (!UINT.test(amount)) throw new RangeError(`not a base-unit amount: ${amount}`);
  const v = BigInt(amount);
  if (v > MAX_UINT256) throw new RangeError("amount exceeds uint256");
  return v.toString(16);
}

export function erc20TransferData(to: string, amount: string): string {
  if (!ADDR.test(to)) throw new RangeError(`not an EVM address: ${to}`);
  return `${ERC20_TRANSFER}${word(to.slice(2).toLowerCase())}${word(uintHex(amount))}`;
}

export interface EvmTxRequest {
  readonly from: string;
  readonly to: string;
  readonly value: string;
  readonly data?: string;
}

export function evmPaymentTx(
  asset: Extract<WalletAsset, { kind: "evm_erc20" | "evm_native" }>,
  depositAddress: string,
  amountIn: string,
  from: string,
): EvmTxRequest {
  if (!ADDR.test(from)) throw new RangeError(`not an EVM address: ${from}`);
  if (!ADDR.test(depositAddress)) throw new RangeError(`not an EVM deposit address: ${depositAddress}`);
  if (asset.kind === "evm_native") {
    return { from, to: depositAddress, value: `0x${uintHex(amountIn)}` };
  }
  return { from, to: asset.token, value: "0x0", data: erc20TransferData(depositAddress, amountIn) };
}

export const hexChainId = (id: number): string => `0x${id.toString(16)}`;
