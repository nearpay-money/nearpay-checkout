/**
 * Network-fee pre-check before a wallet is asked to sign the deposit transfer (lazy chunk). Compares
 * the payer's native balance with a fee estimate (with a safety margin) so a wallet with no ETH / SOL /
 * NEAR gets a clear message instead of a wallet popup that says the transaction will fail.
 *
 * It is a UX guard, not a security check: it only reads (through the wallet's own provider for EVM,
 * the configured NEAR / Solana RPC otherwise), never changes what is signed, and a failed read lets
 * the payment continue to the wallet as before (fail open). Bigint base units throughout (INV-5).
 */
import type { WalletAsset } from "../../lib/chains/chains";
import type { Eip1193Provider } from "../../wallets/evm/provider";
import { erc20BalanceOf, nativeBalance, networkFee } from "../../wallets/evm/reads";
import type { EvmTxRequest } from "../../wallets/evm/tx";
import { availableNear, ftBalanceOf, gasPrice } from "../../wallets/near/balances";
import type { NearTransaction } from "../../wallets/near/tx";
import { solBalance, splBalances } from "../../wallets/solana/balances";
import type { SolanaRecipe } from "../../wallets/solana/tx";

export type GasVerdict =
  | { readonly ok: true }
  /** The token (or the native coin being paid) is below the amount to send. */
  | { readonly ok: false; readonly reason: "funds" }
  /** Enough to send, not enough left for the network fee; `need` = native base units to have for it. */
  | { readonly ok: false; readonly reason: "fee"; readonly need: bigint };

export interface FeeInput {
  /** Spendable native balance. */
  readonly native: bigint;
  /** Estimated network fee (with margin) plus deposits the transaction attaches besides the payment. */
  readonly fee: bigint;
  /** Native amount the payment itself sends (paying with ETH / SOL / NEAR); 0 for tokens. */
  readonly sendNative: bigint;
  /** Token being paid: its balance and the amount to send. */
  readonly token?: { readonly balance: bigint; readonly amount: bigint } | undefined;
  /** Solana: a fee payer must keep 0 or at least the rent-exempt minimum after the transaction. */
  readonly minRemaining?: bigint | undefined;
}

export function assessFee(i: FeeInput): GasVerdict {
  if (i.token && i.token.balance < i.token.amount) return { ok: false, reason: "funds" };
  if (i.native < i.sendNative) return { ok: false, reason: "funds" };
  const left = i.native - i.sendNative - i.fee;
  if (left < 0n) return { ok: false, reason: "fee", need: i.fee };
  if (i.minRemaining !== undefined && left > 0n && left < i.minRemaining) {
    return { ok: false, reason: "fee", need: i.fee + i.minRemaining };
  }
  return { ok: true };
}

/** EVM: `eth_estimateGas` × fee data (+L1 fee on OP-stack chains) through the connected provider. */
export async function checkEvm(
  p: Eip1193Provider,
  tx: EvmTxRequest,
  asset: Extract<WalletAsset, { kind: "evm_erc20" | "evm_native" }>,
  amountIn: string,
): Promise<GasVerdict> {
  const amount = BigInt(amountIn);
  const native = await nativeBalance(p, tx.from);
  const token =
    asset.kind === "evm_erc20" ? { balance: await erc20BalanceOf(p, asset.token, tx.from), amount } : undefined;
  const sendNative = asset.kind === "evm_native" ? amount : 0n;
  // A token or native shortfall is known before estimating (an ERC-20 estimate would revert anyway).
  const early = assessFee({ native, fee: 0n, sendNative, token });
  if (!early.ok) return early;
  return assessFee({ native, fee: await networkFee(p, tx, asset.chainId), sendNative, token });
}

/** Solana base fee per signature (lamports); the check reserves two (wallets may add a priority fee). */
export const SOL_SIGNATURE_FEE = 5000n;
/** Rent-exempt minimum of a system account with no data (lamports). */
export const SOL_ACCOUNT_RENT_MIN = 890_880n;

/** Solana: signature fee (×2) + the deposit token account's rent when the transfer creates it. */
export async function checkSolana(
  url: string,
  owner: string,
  recipe: SolanaRecipe,
  rentLamports: string | null,
): Promise<GasVerdict> {
  const native = BigInt(await solBalance(url, owner));
  const fee = SOL_SIGNATURE_FEE * 2n + BigInt(rentLamports ?? "0");
  if (recipe.kind === "sol") {
    return assessFee({ native, fee, sendNative: BigInt(recipe.lamports), minRemaining: SOL_ACCOUNT_RENT_MIN });
  }
  const held = BigInt((await splBalances(url, owner)).get(recipe.mint) ?? "0");
  return assessFee({
    native,
    fee,
    sendNative: 0n,
    token: { balance: held, amount: BigInt(recipe.amount) },
    minRemaining: SOL_ACCOUNT_RENT_MIN,
  });
}

/** Margin over prepaid gas × gas price (receipts may be charged at a higher, pessimistic price). */
export const NEAR_GAS_MARGIN = 2n;

/**
 * NEAR: attached gas × gas price (×2) plus attached deposits (storage registration, 1 yocto); paying
 * wNEAR sends the amount from native NEAR (`near_deposit`).
 */
export async function checkNear(
  rpc: string,
  account: string,
  txs: readonly NearTransaction[],
  token: { readonly token: string; readonly amount: string } | null,
): Promise<GasVerdict> {
  let gas = 0n;
  let deposits = 0n;
  let sendNative = 0n;
  for (const tx of txs) {
    for (const a of tx.actions) {
      gas += BigInt(a.params.gas);
      if (a.params.methodName === "near_deposit") sendNative += BigInt(a.params.deposit);
      else deposits += BigInt(a.params.deposit);
    }
  }
  const [native, price, held] = await Promise.all([
    availableNear(rpc, account),
    gasPrice(rpc),
    token ? ftBalanceOf(rpc, token.token, account) : Promise.resolve(null),
  ]);
  return assessFee({
    native: BigInt(native),
    fee: gas * BigInt(price) * NEAR_GAS_MARGIN + deposits,
    sendNative,
    token: token && held !== null ? { balance: BigInt(held), amount: BigInt(token.amount) } : undefined,
  });
}
