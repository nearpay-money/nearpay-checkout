/**
 * Auto-pay fixtures (spec 0.4.1): `MandateFundingInstructions` and `PublicMandate`
 * as billing returns them for the hosted invoice page. The `msg` strings are the spec's
 * `test-vectors/vault.json` `msgs` (the contract's own wire strings).
 */
import type {
  Funding as MandateFundingInstructions,
  Mandate as PublicMandate,
} from "../../src/routes/invoice/autopay/model";

export const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const VAULT = "vault.sandbox.near";
export const SUB = "sub_01jbz9k3m4n5p6q7r8s9t0v1w2";
export const MSG_START_NOW =
  '{"create_mandate":{"merchant_receiver":"merchant-demo.near","receiver_kind":"intents_account","amount_per_period":"10000000","period_secs":2629746,"start_at":null,"max_periods":null,"fee_bps":100,"ext_ref":"sub_01jbz9k3m4n5p6q7r8s9t0v1w2"}}';
export const MSG_TOP_UP = '{"top_up":{"mandate_id":7}}';
const TGAS = "000000000000";

/** Funding for `periods` (amount per period 10 USDC, monthly), storage deposit unless `registered`. */
export function funding(
  over: Partial<MandateFundingInstructions> & { periods?: number; payer?: string | null; registered?: boolean } = {},
): MandateFundingInstructions {
  const periods = over.periods ?? 3;
  const amount = (10_000_000n * BigInt(periods)).toString();
  const payer = over.payer ?? null;
  const storageDeposit = over.registered ? "0" : "12000000000000000000000";
  const ft = {
    signer_id: null,
    receiver_id: USDC,
    actions: [
      {
        type: "FunctionCall" as const,
        method_name: "ft_transfer_call",
        args: { receiver_id: VAULT, amount, msg: MSG_START_NOW },
        gas: `100${TGAS}`,
        deposit: "1",
      },
    ],
  };
  const storage = {
    signer_id: null,
    receiver_id: VAULT,
    actions: [
      {
        type: "FunctionCall" as const,
        method_name: "storage_deposit",
        args: payer ? { account_id: payer } : {},
        gas: `30${TGAS}`,
        deposit: storageDeposit,
      },
    ],
  };
  const { registered: _r, ...rest } = over;
  return {
    object: "mandate_funding_instructions",
    livemode: true,
    subscription: SUB,
    vault_contract: VAULT,
    token: USDC,
    asset_id: `nep141:${USDC}`,
    amount,
    periods,
    amount_per_period: "10000000",
    period_secs: 2_629_746,
    start_at: null,
    fee_bps: 100,
    merchant_receiver: "merchant-demo.near",
    receiver_kind: "intents_account",
    settlement_destination: "sd_01jbz9k3m4n5p6q7r8s9t0v1w2",
    ext_ref: SUB,
    msg: MSG_START_NOW,
    payer,
    storage: { payer_registered: payer ? Boolean(over.registered) : null, deposit: storageDeposit },
    payer_notice:
      "Sign both transactions from your own NEAR account and pay the gas yourself. Relayer or gasless wallets, NEAR Intents balances, bridges and smart wallets cannot fund a mandate: the vault refunds such deposits. You can cancel at any time from the NEAR account you pay with; the remaining balance goes back to it.",
    transactions: over.registered ? [ft] : [storage, ft],
    ...rest,
  } as MandateFundingInstructions;
}

const exit = (method: "cancel" | "withdraw") => ({
  signer_id: null,
  receiver_id: VAULT,
  actions: [
    { type: "FunctionCall" as const, method_name: method, args: { mandate_id: 7 }, gas: `100${TGAS}`, deposit: "1" },
  ],
});

export function mandate(over: Partial<PublicMandate> = {}): PublicMandate {
  return {
    id: "md_01jbz9k3m4n5p6q7r8s9t0v1w2",
    object: "mandate",
    livemode: true,
    status: "active",
    link_status: "linked",
    payer: "payer.near",
    vault_contract: VAULT,
    onchain_id: 7,
    token: USDC,
    asset_id: `nep141:${USDC}`,
    amount_per_period: "10000000",
    period_secs: 2_629_746,
    balance: "20000000",
    funded_periods: 2,
    collected_periods: 1,
    next_collect_at: 4_102_444_800,
    collecting: true,
    top_up_msg: MSG_TOP_UP,
    transactions: { cancel: exit("cancel"), withdraw: null },
    ...over,
  };
}

export const withdrawTx = exit("withdraw");
