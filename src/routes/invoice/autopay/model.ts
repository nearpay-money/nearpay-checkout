/**
 * Hosted invoice auto-pay (Stage 4; lld/billing.md §5, §14 d5/d8, lld/contracts-vault.md §3.1 funding
 * UX rule, lld/checkout-and-js.md §4.4): pure logic over `MandateFundingInstructions` and `PublicMandate`.
 *
 * The payer signs exactly what billing returned, but only after this module has checked that the
 * transactions are the ones the terms on screen describe (fail closed, nothing is signed otherwise):
 * - `storage_deposit` on the vault with the stated storage deposit (when present);
 * - `ft_transfer_call` on the **token** with `args = {receiver_id: vault, amount, msg}`, 1 yoctoNEAR,
 *   whose `msg` is a `create_mandate` with the same receiver, amount per period, period and fee as shown;
 * - `signer_id` null or the connected account (the payer signs from their own account — no relayer).
 * Terms are displayed from the parsed `msg` (what the vault will store), not from free-text fields.
 * Money stays base-unit strings (INV-5).
 */
import type { MoneyFormatOptions } from "@nearpay-internal/ui";
import type { z } from "zod";
import type { MessageKey } from "../../../lib/i18n/messages.en";
import {
  type MandateFundingInstructions,
  type NearTransactionRequest,
  ONE_YOCTO,
  type PublicMandate,
  VAULT_PERIOD_SECS_PER_INTERVAL,
  VaultMsg,
} from "../../../lib/spec-gap-0.4.0/billing";
import type { FunctionCallAction, NearTransaction } from "../../../wallets/near/tx";
import type { Invoice } from "../model";

export type Funding = MandateFundingInstructions;
export type Mandate = PublicMandate;
type CreateArgs = Extract<z.output<typeof VaultMsg>, { create_mandate: unknown }>["create_mandate"];

/** Periods a payer can fund up front (billing accepts 1–36, default 3). */
export const PERIOD_CHOICES = [1, 3, 6, 12] as const;
export const DEFAULT_PERIODS = 3;
/** After the funding transaction: re-read the invoice until billing has recorded the mandate. */
export const MANDATE_POLL_MS = 3000;
export const MANDATE_POLL_MAX = 40;
const TGAS = 1_000_000_000_000n;
/** `MIN_EXIT_GAS`: cancel/withdraw below it fail with ERR_GAS (billing attaches 100 Tgas). */
const MIN_EXIT_GAS = 50n * TGAS;
const FT_TRANSFER_CALL_GAS = 100n * TGAS;

// ---- token display (spec gap: MandateFundingInstructions/PublicMandate carry no symbol/decimals) -----

export interface TokenMeta {
  readonly symbol: string;
  readonly decimals: number;
}

/**
 * The v1 vault tokens (billing §14 d2: USD at par in USDC or USDT; sandbox stand-in allows the same
 * accounts). Other tokens use the invoice's pricing asset when it is the same token, else raw base units.
 */
const VAULT_TOKENS: Readonly<Record<string, TokenMeta>> = {
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": { symbol: "USDC", decimals: 6 },
  "usdt.tether-token.near": { symbol: "USDT", decimals: 6 },
};

export function tokenMeta(token: string, inv: Pick<Invoice, "pricing_asset" | "asset_id"> | null): TokenMeta | null {
  const known = VAULT_TOKENS[token];
  if (known) return known;
  const p = inv?.pricing_asset;
  if (p && inv?.asset_id === `nep141:${token}`) return { symbol: p.symbol, decimals: p.decimals };
  return null;
}

export function tokenMoney(amount: string, meta: TokenMeta | null): MoneyFormatOptions | null {
  return meta ? { amount, decimals: meta.decimals, symbol: meta.symbol } : null;
}

/** yoctoNEAR (24 decimals) for the storage line. */
export const nearMoney = (yocto: string): MoneyFormatOptions => ({
  amount: yocto,
  decimals: 24,
  symbol: "NEAR",
  maxFraction: 4,
  rounding: "ceil",
});

/** "month", "3 months", "week", … for a vault period; null for an irregular length. */
export function periodLabel(secs: number): { key: MessageKey; n: number } | null {
  const units: [keyof typeof VAULT_PERIOD_SECS_PER_INTERVAL, number][] = [
    ["year", VAULT_PERIOD_SECS_PER_INTERVAL.year],
    ["month", VAULT_PERIOD_SECS_PER_INTERVAL.month],
    ["week", VAULT_PERIOD_SECS_PER_INTERVAL.week],
    ["day", VAULT_PERIOD_SECS_PER_INTERVAL.day],
  ];
  for (const [unit, len] of units) {
    if (secs % len === 0) {
      const n = secs / len;
      return { key: `autopay.every.${unit}${n === 1 ? "" : "s"}` as MessageKey, n };
    }
  }
  return null;
}

// ---- checks before signing ------------------------------------------------------------------------

export type FundingProblem =
  | "msg" // msg is not a create_mandate the vault parses
  | "terms" // msg terms differ from the instruction's fields
  | "amount" // amount ≠ periods × amount_per_period
  | "transactions" // the transactions are not exactly storage_deposit (vault) + ft_transfer_call (token)
  | "signer"; // signer_id names another account

export interface FundingTerms {
  readonly merchantReceiver: string;
  readonly receiverKind: string;
  readonly amountPerPeriod: string;
  readonly periodSecs: number;
  /** Nanoseconds since epoch as a string; null = the vault starts at block time (first collection now). */
  readonly startAt: string | null;
  readonly maxPeriods: number | null;
  readonly feeBps: number;
  readonly amount: string;
  readonly periods: number;
  readonly storageDeposit: string;
}

export type FundingCheck =
  | { readonly ok: true; readonly terms: FundingTerms; readonly transactions: NearTransaction[] }
  | { readonly ok: false; readonly problem: FundingProblem };

function fnCall(a: NearTransactionRequest["actions"][number]): FunctionCallAction {
  return {
    type: "FunctionCall",
    params: { methodName: a.method_name, args: a.args, gas: a.gas, deposit: a.deposit },
  };
}

/** NEAR Connect's transaction format (camelCase), signer = the connected wallet. */
export function toNearTransactions(list: readonly NearTransactionRequest[]): NearTransaction[] {
  return list.map((t) => ({ receiverId: t.receiver_id, actions: t.actions.map(fnCall) }));
}

function parseCreate(msg: string): CreateArgs | null {
  try {
    const r = VaultMsg.safeParse(JSON.parse(msg));
    return r.success && "create_mandate" in r.data ? r.data.create_mandate : null;
  } catch {
    return null;
  }
}

const signerOk = (t: NearTransactionRequest, payer: string | null) =>
  t.signer_id === null || (payer !== null && t.signer_id === payer);

/**
 * Checks funding instructions against the terms they claim, for the connected `payer` (null in test
 * mode, where nothing is signed). Returns the terms to display and the exact transactions to sign.
 */
export function checkFunding(f: Funding, payer: string | null): FundingCheck {
  const c = parseCreate(f.msg);
  if (!c) return { ok: false, problem: "msg" };
  if (
    c.merchant_receiver !== f.merchant_receiver ||
    c.receiver_kind !== f.receiver_kind ||
    c.amount_per_period !== f.amount_per_period ||
    c.period_secs !== f.period_secs ||
    c.fee_bps !== f.fee_bps ||
    c.ext_ref !== f.ext_ref ||
    (c.start_at ?? null) !== f.start_at
  ) {
    return { ok: false, problem: "terms" };
  }
  if (BigInt(f.amount) !== BigInt(f.periods) * BigInt(f.amount_per_period) || BigInt(f.amount) <= 0n) {
    return { ok: false, problem: "amount" };
  }
  const txs = f.transactions;
  const last = txs[txs.length - 1];
  const storage = txs.length === 2 ? txs[0] : null;
  if (!last || txs.length > 2) return { ok: false, problem: "transactions" };
  for (const t of txs) if (!signerOk(t, payer)) return { ok: false, problem: "signer" };

  // ft_transfer_call on the token → the vault, exactly the amount and msg shown.
  const ft = last.actions[0];
  const args = ft?.args as Record<string, unknown> | undefined;
  if (
    last.receiver_id !== f.token ||
    last.actions.length !== 1 ||
    !ft ||
    ft.method_name !== "ft_transfer_call" ||
    ft.deposit !== ONE_YOCTO ||
    BigInt(ft.gas) < FT_TRANSFER_CALL_GAS ||
    !args ||
    Object.keys(args).sort().join() !== "amount,msg,receiver_id" ||
    args.receiver_id !== f.vault_contract ||
    args.amount !== f.amount ||
    args.msg !== f.msg
  ) {
    return { ok: false, problem: "transactions" };
  }
  // storage_deposit on the vault for the payer's own account, exactly the stated deposit.
  if (storage) {
    const s = storage.actions[0];
    const sargs = (s?.args ?? {}) as Record<string, unknown>;
    const account = sargs.account_id;
    if (
      storage.receiver_id !== f.vault_contract ||
      storage.actions.length !== 1 ||
      !s ||
      s.method_name !== "storage_deposit" ||
      s.deposit !== f.storage.deposit ||
      BigInt(s.deposit) <= 0n ||
      Object.keys(sargs).some((k) => k !== "account_id" && k !== "registration_only") ||
      (account !== undefined && account !== null && account !== payer)
    ) {
      return { ok: false, problem: "transactions" };
    }
  } else if (BigInt(f.storage.deposit) > 0n) {
    return { ok: false, problem: "transactions" };
  }
  return {
    ok: true,
    terms: {
      merchantReceiver: c.merchant_receiver,
      receiverKind: c.receiver_kind,
      amountPerPeriod: c.amount_per_period,
      periodSecs: c.period_secs,
      startAt: c.start_at ?? null,
      maxPeriods: c.max_periods ?? null,
      feeBps: c.fee_bps,
      amount: f.amount,
      periods: f.periods,
      storageDeposit: f.storage.deposit,
    },
    transactions: toNearTransactions(txs),
  };
}

// ---- copy derived from the prepared terms ------------------------------------------------------------

/** `fee_bps` as a percentage string without floats ("1", "1.25", "0.5"); null when absent or invalid. */
export function feePercent(bps: number | null | undefined): string | null {
  if (typeof bps !== "number" || !Number.isInteger(bps) || bps < 0 || bps > 10_000) return null;
  const whole = Math.floor(bps / 100);
  const frac = String(bps % 100)
    .padStart(2, "0")
    .replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/** The fee bullet for the prepared `fee_bps`: with the rate, "no NearPay fee", or without a rate. */
export function feeFact(bps: number | null | undefined): { key: MessageKey; vars: Record<string, string> } {
  const pct = feePercent(bps);
  if (pct === null) return { key: "autopay.factFeesNoRate", vars: {} };
  if (pct === "0") return { key: "autopay.factFeesNone", vars: {} };
  return { key: "autopay.factFees", vars: { fee: pct } };
}

/**
 * The sentence of billing's default `payer_notice` (spec 0.4.0 `MANDATE_FUNDING_PAYER_NOTICE`) that
 * overstates who can cancel: the vault accepts cancel/withdraw only from the paying account (spec CR).
 */
const NOTICE_ANY_WALLET = "You can cancel at any time from any NEAR wallet and get the remaining balance back.";

/** `payer_notice` as shown: verbatim, except the inaccurate cancel sentence, which is corrected. */
export function payerNoticeText(notice: string, corrected: string): string {
  return notice.includes(NOTICE_ANY_WALLET) ? notice.replace(NOTICE_ANY_WALLET, corrected) : notice;
}

/** `start_at` (ns string) → epoch ms; null = now. */
export const startAtMs = (ns: string | null): number | null => (ns === null ? null : Number(BigInt(ns) / 1_000_000n));

// ---- management (payer) ---------------------------------------------------------------------------

export type MandateKind = "active" | "insufficient" | "exhausted" | "canceled" | "unknown";

export interface MandateView {
  readonly kind: MandateKind;
  readonly badge: { readonly label: MessageKey; readonly tone: "success" | "warning" | "neutral" | "danger" };
  /** The payer should cancel to get the balance back: on-chain active but no longer collected / unlinked. */
  readonly orphaned: boolean;
  readonly canTopUp: boolean;
}

export function mandateView(m: Pick<Mandate, "status" | "link_status" | "collecting" | "top_up_msg">): MandateView {
  const kind: MandateKind = ["active", "insufficient", "exhausted", "canceled"].includes(m.status)
    ? (m.status as MandateKind)
    : "unknown";
  const live = kind === "active" || kind === "insufficient";
  const orphaned = live && (!m.collecting || m.link_status !== "linked");
  const badge: MandateView["badge"] =
    kind === "active"
      ? { label: "autopay.status.active", tone: "success" }
      : kind === "insufficient"
        ? { label: "autopay.status.insufficient", tone: "warning" }
        : kind === "exhausted"
          ? { label: "autopay.status.exhausted", tone: "neutral" }
          : kind === "canceled"
            ? { label: "autopay.status.canceled", tone: "neutral" }
            : { label: "autopay.status.unknown", tone: "neutral" };
  return { kind, badge, orphaned, canTopUp: live && !orphaned && m.top_up_msg !== null };
}

/**
 * The payer's top-up: `ft_transfer_call` on the mandate's token to the vault with `top_up_msg` and the
 * chosen amount (vault refunds deposits whose sender is not the payer, so the payer signs it).
 */
export function topUpTransaction(m: Mandate, amount: string): NearTransaction {
  if (!m.top_up_msg) throw new Error("no top-up for this mandate");
  if (!/^[1-9][0-9]{0,38}$/.test(amount)) throw new RangeError("bad amount");
  const msg = VaultMsg.safeParse(JSON.parse(m.top_up_msg));
  if (!msg.success || !("top_up" in msg.data) || msg.data.top_up.mandate_id !== m.onchain_id) {
    throw new Error("top-up message doesn't name this mandate");
  }
  return {
    receiverId: m.token,
    actions: [
      {
        type: "FunctionCall",
        params: {
          methodName: "ft_transfer_call",
          args: { receiver_id: m.vault_contract, amount, msg: m.top_up_msg },
          gas: FT_TRANSFER_CALL_GAS.toString(),
          deposit: ONE_YOCTO,
        },
      },
    ],
  };
}

/**
 * The payer's prepared `cancel` / `withdraw`: on the vault, one call of that method for this mandate,
 * 1 yoctoNEAR, ≥ MIN_EXIT_GAS (50 Tgas), signer null or the payer. Null when it doesn't check out.
 */
export function exitTransaction(m: Mandate, which: "cancel" | "withdraw"): NearTransaction | null {
  const t = m.transactions[which];
  const a = t?.actions[0];
  if (!t || !a || t.actions.length !== 1) return null;
  const args = a.args as Record<string, unknown>;
  if (
    t.receiver_id !== m.vault_contract ||
    a.method_name !== which ||
    a.deposit !== ONE_YOCTO ||
    BigInt(a.gas) < MIN_EXIT_GAS ||
    args.mandate_id !== m.onchain_id ||
    (t.signer_id !== null && t.signer_id !== m.payer)
  ) {
    return null;
  }
  return toNearTransactions([t])[0] ?? null;
}
