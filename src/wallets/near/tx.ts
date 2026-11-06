/**
 * NEAR deposits built inside the checkout (lld/checkout-and-js.md §5.4): NEP-141 — `storage_deposit`
 * for the deposit account when it is not registered, then `ft_transfer({receiver_id: deposit, amount:
 * amount_in, memo})`; wNEAR from native NEAR — `near_deposit` + transfer in the same batch.
 * Transactions use the wallet-selector action format that NEAR Connect accepts.
 */
import type { WalletAsset } from "../../lib/chains/chains";

export interface FunctionCallAction {
  readonly type: "FunctionCall";
  readonly params: {
    readonly methodName: string;
    readonly args: object;
    readonly gas: string;
    readonly deposit: string;
  };
}

export interface NearTransaction {
  readonly receiverId: string;
  readonly actions: readonly FunctionCallAction[];
}

const TGAS = 1_000_000_000_000n;
const ONE_YOCTO = "1";

const call = (methodName: string, args: object, gasT: bigint, deposit: string): FunctionCallAction => ({
  type: "FunctionCall",
  params: { methodName, args, gas: (gasT * TGAS).toString(), deposit },
});

export interface NearDepositInput {
  readonly asset: Extract<WalletAsset, { kind: "near_nep141" | "near_wrap" }>;
  readonly depositAddress: string;
  readonly amountIn: string;
  readonly memo: string | null;
  /** Whether the deposit account already has storage on the token contract. */
  readonly registered: boolean;
  /** `storage_balance_bounds().min` of the token contract (yoctoNEAR). */
  readonly storageMin: string;
}

export function nearDepositTransactions(i: NearDepositInput): NearTransaction[] {
  if (!/^(0|[1-9][0-9]{0,77})$/.test(i.amountIn) || BigInt(i.amountIn) <= 0n) throw new RangeError("bad amount");
  const actions: FunctionCallAction[] = [];
  if (!i.registered) {
    actions.push(call("storage_deposit", { account_id: i.depositAddress, registration_only: true }, 10n, i.storageMin));
  }
  if (i.asset.kind === "near_wrap") actions.push(call("near_deposit", {}, 10n, i.amountIn));
  const transfer: Record<string, string> = { receiver_id: i.depositAddress, amount: i.amountIn };
  if (i.memo) transfer.memo = i.memo;
  actions.push(call("ft_transfer", transfer, 30n, ONE_YOCTO));
  return [{ receiverId: i.asset.token, actions }];
}

/** Picks the deposit transaction hash out of NEAR Connect's `signAndSendTransactions` result. */
export function depositTxHash(outcomes: unknown): string {
  const list = Array.isArray(outcomes) ? outcomes : [outcomes];
  const last = list[list.length - 1] as
    | { transaction?: { hash?: unknown }; transaction_outcome?: { id?: unknown } }
    | undefined;
  const hash = last?.transaction?.hash ?? last?.transaction_outcome?.id;
  if (typeof hash !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(hash))
    throw new Error("The wallet returned no transaction hash.");
  return hash;
}
