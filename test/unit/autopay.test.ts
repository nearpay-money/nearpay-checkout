/** Hosted invoice auto-pay (Stage 4, §4.4): funding checks before signing, mandate view, payer transactions. */
import { describe, expect, it } from "vitest";
import { autopayEn } from "../../src/lib/i18n/messages.autopay.en";
import { registerMessages, t } from "../../src/lib/i18n/t";
import {
  MANDATE_FUNDING_PAYER_NOTICE,
  MandateFundingInstructions,
  PublicMandate,
  VaultMsg,
} from "../../src/lib/spec-gap-0.4.0/billing";
import {
  checkFunding,
  exitTransaction,
  feeFact,
  feePercent,
  mandateView,
  payerNoticeText,
  periodLabel,
  startAtMs,
  tokenMeta,
  topUpTransaction,
} from "../../src/routes/invoice/autopay/model";
import { funding, MSG_START_NOW, mandate, USDC, VAULT, withdrawTx } from "../support/mandates";

const wAction = withdrawTx.actions[0] as (typeof withdrawTx.actions)[number];

describe("fixtures follow the 0.4.0 schemas", () => {
  it("funding and mandate parse; msg is a vault create_mandate", () => {
    expect(MandateFundingInstructions.safeParse(funding()).success).toBe(true);
    expect(MandateFundingInstructions.safeParse(funding({ payer: "payer.near", registered: true })).success).toBe(true);
    expect(PublicMandate.safeParse(mandate()).success).toBe(true);
    expect(VaultMsg.safeParse(JSON.parse(MSG_START_NOW)).success).toBe(true);
    expect(funding().payer_notice).toBe(MANDATE_FUNDING_PAYER_NOTICE);
  });
});

describe("checkFunding (fail closed before signing)", () => {
  it("accepts storage_deposit (vault) + ft_transfer_call (token → vault) and returns terms from the msg", () => {
    const r = checkFunding(funding({ payer: "payer.near" }), "payer.near");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.terms).toMatchObject({
      merchantReceiver: "merchant-demo.near",
      amountPerPeriod: "10000000",
      periodSecs: 2_629_746,
      startAt: null,
      feeBps: 100,
      amount: "30000000",
      periods: 3,
    });
    expect(r.transactions).toHaveLength(2);
    expect(r.transactions[0]).toMatchObject({
      receiverId: VAULT,
      actions: [{ params: { methodName: "storage_deposit" } }],
    });
    expect(r.transactions[1]).toEqual({
      receiverId: USDC,
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: "ft_transfer_call",
            args: { receiver_id: VAULT, amount: "30000000", msg: MSG_START_NOW },
            gas: "100000000000000",
            deposit: "1",
          },
        },
      ],
    });
  });

  it("registered payer: one transaction; storage deposit without a storage tx is refused", () => {
    const f = funding({ payer: "payer.near", registered: true });
    expect(checkFunding(f, "payer.near")).toMatchObject({ ok: true });
    expect(checkFunding({ ...f, storage: { payer_registered: true, deposit: "1" } }, "payer.near")).toEqual({
      ok: false,
      problem: "transactions",
    });
  });

  it("refuses a msg whose terms differ from the shown fields", () => {
    expect(checkFunding({ ...funding(), amount_per_period: "9000000", amount: "27000000" }, null)).toEqual({
      ok: false,
      problem: "terms",
    });
    expect(checkFunding({ ...funding(), merchant_receiver: "evil.near" }, null)).toMatchObject({ problem: "terms" });
    expect(checkFunding({ ...funding(), msg: '{"top_up":{"mandate_id":1}}' }, null)).toMatchObject({ problem: "msg" });
    expect(checkFunding({ ...funding(), msg: "nope" }, null)).toMatchObject({ problem: "msg" });
  });

  it("refuses an amount that is not periods × amount per period", () => {
    expect(checkFunding({ ...funding(), amount: "1" }, null)).toMatchObject({ problem: "amount" });
  });

  it("refuses transfers to anything but the token with receiver_id = vault, the exact amount and msg", () => {
    const f = funding();
    const ft = f.transactions[1];
    if (!ft) throw new Error("fixture");
    const variants = [
      { ...ft, receiver_id: "other-token.near" },
      { ...ft, actions: [{ ...ft.actions[0], args: { ...ft.actions[0]?.args, receiver_id: "evil.near" } }] },
      { ...ft, actions: [{ ...ft.actions[0], args: { ...ft.actions[0]?.args, amount: "30000001" } }] },
      { ...ft, actions: [{ ...ft.actions[0], args: { ...ft.actions[0]?.args, extra: 1 } }] },
      { ...ft, actions: [{ ...ft.actions[0], method_name: "ft_transfer" }] },
      { ...ft, actions: [{ ...ft.actions[0], deposit: "2" }] },
      { ...ft, actions: [{ ...ft.actions[0], gas: "30000000000000" }] },
    ];
    for (const v of variants) {
      expect(checkFunding({ ...f, transactions: [f.transactions[0], v] } as typeof f, null)).toMatchObject({
        ok: false,
      });
    }
    // storage_deposit to another contract or with another deposit
    const st = f.transactions[0];
    if (!st) throw new Error("fixture");
    expect(
      checkFunding({ ...f, transactions: [{ ...st, receiver_id: "evil.near" }, ft] } as typeof f, null),
    ).toMatchObject({ problem: "transactions" });
    expect(
      checkFunding(
        { ...f, transactions: [{ ...st, actions: [{ ...st.actions[0], deposit: "99" }] }, ft] } as typeof f,
        null,
      ),
    ).toMatchObject({ problem: "transactions" });
  });

  it("signer must be null or the connected payer (no relayer)", () => {
    const f = funding({ payer: "payer.near" });
    const withSigner = { ...f, transactions: f.transactions.map((t) => ({ ...t, signer_id: "relayer.near" })) };
    expect(checkFunding(withSigner, "payer.near")).toEqual({ ok: false, problem: "signer" });
    const own = { ...f, transactions: f.transactions.map((t) => ({ ...t, signer_id: "payer.near" })) };
    expect(checkFunding(own, "payer.near")).toMatchObject({ ok: true });
    // storage for another account
    const st = f.transactions[0];
    if (!st) throw new Error("fixture");
    const other = {
      ...f,
      transactions: [{ ...st, actions: [{ ...st.actions[0], args: { account_id: "x.near" } }] }, f.transactions[1]],
    } as typeof f;
    expect(checkFunding(other, "payer.near")).toMatchObject({ problem: "transactions" });
  });
});

describe("mandate view and payer transactions", () => {
  it("status badges, orphaned and top-up availability", () => {
    expect(mandateView(mandate())).toMatchObject({ kind: "active", orphaned: false, canTopUp: true });
    expect(mandateView(mandate({ status: "insufficient" })).badge.label).toBe("autopay.status.insufficient");
    expect(mandateView(mandate({ collecting: false }))).toMatchObject({ orphaned: true, canTopUp: false });
    expect(mandateView(mandate({ link_status: "unlinked" }))).toMatchObject({ orphaned: true });
    expect(mandateView(mandate({ status: "canceled", top_up_msg: null }))).toMatchObject({
      kind: "canceled",
      canTopUp: false,
    });
    expect(mandateView(mandate({ status: "frozen" as never })).kind).toBe("unknown");
  });

  it("top-up = ft_transfer_call on the token to the vault with top_up_msg", () => {
    expect(topUpTransaction(mandate(), "30000000")).toEqual({
      receiverId: USDC,
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: "ft_transfer_call",
            args: { receiver_id: VAULT, amount: "30000000", msg: '{"top_up":{"mandate_id":7}}' },
            gas: "100000000000000",
            deposit: "1",
          },
        },
      ],
    });
    expect(() => topUpTransaction(mandate({ top_up_msg: '{"top_up":{"mandate_id":8}}' }), "1")).toThrow();
    expect(() => topUpTransaction(mandate(), "0")).toThrow();
    expect(() => topUpTransaction(mandate({ top_up_msg: null }), "1")).toThrow();
  });

  it("cancel / withdraw only as prepared for this mandate on the vault", () => {
    expect(exitTransaction(mandate(), "cancel")).toMatchObject({
      receiverId: VAULT,
      actions: [{ params: { methodName: "cancel", args: { mandate_id: 7 }, deposit: "1" } }],
    });
    expect(exitTransaction(mandate(), "withdraw")).toBeNull();
    expect(
      exitTransaction(mandate({ transactions: { cancel: null, withdraw: withdrawTx } }), "withdraw"),
    ).not.toBeNull();
    const bad = (patch: object) =>
      exitTransaction(
        mandate({ transactions: { cancel: { ...withdrawTx, ...patch } as never, withdraw: null } }),
        "cancel",
      );
    expect(bad({})).toBeNull(); // method withdraw under "cancel"
    expect(
      exitTransaction(
        mandate({
          transactions: {
            cancel: { ...withdrawTx, receiver_id: "evil.near", actions: [{ ...wAction, method_name: "cancel" }] },
            withdraw: null,
          },
        }),
        "cancel",
      ),
    ).toBeNull();
    expect(
      exitTransaction(
        mandate({
          transactions: {
            cancel: { ...withdrawTx, actions: [{ ...wAction, method_name: "cancel", gas: "10000000000000" }] },
            withdraw: null,
          },
        }),
        "cancel",
      ),
    ).toBeNull();
  });

  it("periods, start time and token display", () => {
    expect(periodLabel(2_629_746)).toEqual({ key: "autopay.every.month", n: 1 });
    expect(periodLabel(2 * 604_800)).toEqual({ key: "autopay.every.weeks", n: 2 });
    expect(periodLabel(31_556_952)).toEqual({ key: "autopay.every.year", n: 1 });
    expect(periodLabel(100_000)).toBeNull();
    expect(startAtMs(null)).toBeNull();
    expect(startAtMs("1794268800000000000")).toBe(1_794_268_800_000);
    expect(tokenMeta(USDC, null)).toEqual({ symbol: "USDC", decimals: 6 });
    expect(tokenMeta("usdt.tether-token.near", null)).toEqual({ symbol: "USDT", decimals: 6 });
    expect(tokenMeta("x.near", null)).toBeNull();
    expect(
      tokenMeta("x.near", { asset_id: "nep141:x.near", pricing_asset: { symbol: "X", decimals: 18 } as never }),
    ).toEqual({ symbol: "X", decimals: 18 });
  });
});

describe("copy derived from the prepared terms", () => {
  it("renders the fee from fee_bps without floats; omits the rate when absent", () => {
    expect(feePercent(100)).toBe("1");
    expect(feePercent(125)).toBe("1.25");
    expect(feePercent(50)).toBe("0.5");
    expect(feePercent(5)).toBe("0.05");
    expect(feePercent(0)).toBe("0");
    expect(feePercent(null)).toBeNull();
    expect(feePercent(undefined)).toBeNull();
    expect(feePercent(1.5)).toBeNull();
    expect(feePercent(10_001)).toBeNull();
    const text = (bps: number | null) => {
      const f = feeFact(bps);
      return t(f.key, f.vars);
    };
    registerMessages(autopayEn);
    expect(text(250)).toContain("NearPay's 2.5% out of each collection");
    expect(text(100)).toContain("NearPay's 1% out of each collection");
    expect(text(0)).toBe("No fees are added for you; your wallet pays a small NEAR network fee.");
    expect(text(null)).toContain("The merchant pays NearPay's fee out of each collection");
    expect(text(null)).not.toMatch(/%/);
    // The fee shown is the one in the checked vault msg.
    const r = checkFunding(funding(), null);
    expect(r.ok && feeFact(r.terms.feeBps).vars.fee).toBe("1");
  });

  it("corrects billing's default cancel sentence: only the paying account can cancel", () => {
    const fixed =
      "You can cancel at any time from the NEAR account you pay with; the remaining balance goes back to it.";
    const shown = payerNoticeText(MANDATE_FUNDING_PAYER_NOTICE, fixed);
    expect(shown).not.toContain("any NEAR wallet");
    expect(shown).toContain(fixed);
    expect(shown).toContain("Sign both transactions from your own NEAR account");
    expect(payerNoticeText("Sign from your own account.", fixed)).toBe("Sign from your own account.");
  });
});
