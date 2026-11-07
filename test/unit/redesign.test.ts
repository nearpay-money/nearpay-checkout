/** Step 2.3: phase → Figma screen mapping, new machine events, spec 0.2.0 fields, display helpers. */
import { describe, expect, it } from "vitest";
import { type Event, initialState, type Option, reducer, type State } from "../../src/app/machine";
import { linkSessionPath } from "../../src/app/route";
import { INSUFFICIENT_FUNDS, PHASE_SCREENS, type ScreenContext, screenFor } from "../../src/app/screens";
import { filterOptions, networksOf, optionTitle, payableOptions } from "../../src/features/asset-picker/options";
import { walletAsset } from "../../src/lib/chains/chains";
import type { VerifiedInstructions } from "../../src/lib/integrity/verify";
import { verifyAttestation } from "../../src/lib/integrity/verify";
import {
  assetMeta,
  currencySymbol,
  paidAssetId,
  priceMoney,
  statedFee,
  totalToSend,
} from "../../src/lib/money/display";
import { attemptFor, PINNED, sentinelVectors, signAttestation, VECTOR_TIME } from "../support/fixtures";
import { attempt, SECRET, SESSION_ID, session, USDC_BASE, USDC_NEAR } from "../support/sessions";

const run = (events: Event[], from: State = initialState): State => events.reduce(reducer, from);
const opt = (over: Partial<Option> = {}): Option => ({
  method: "route_quote",
  origin_asset_id: USDC_BASE,
  chain: "eip155:8453",
  symbol: "USDC",
  decimals: 6,
  estimated_amount_in: "2005013",
  route_class: "stable_pair",
  min_deadline_s: 300,
  available: true,
  reason: null,
  ...over,
});
const verified = (id = attempt().id): VerifiedInstructions =>
  ({
    attestation: { attempt_id: id, kind: "route_quote" },
    kid: "k",
    validUntil: 1,
  }) as unknown as VerifiedInstructions;
const ctx: ScreenContext = { manualForm: false, busy: false, slow: false, totalChanged: false };
const live = session({ livemode: true });

const toPayWallet: Event[] = [
  { type: "session_loaded", session: live },
  { type: "choose_path", path: "wallet" },
  { type: "wallet_connected", wallet: { family: "evm", address: "0xabc", label: "W" } },
  { type: "options_loaded", options: [opt()] },
  { type: "select_option", option: opt() },
  { type: "confirm" },
  { type: "attempt_created", attempt: attempt({ livemode: true }) },
  { type: "verified", verified: verified() },
];

describe("screen mapping (every §4 phase lands on a Figma frame)", () => {
  it("covers every phase and only maps to listed screens", () => {
    const phases = Object.keys(PHASE_SCREENS);
    expect(phases).toHaveLength(16);
    for (const phase of phases) expect(PHASE_SCREENS[phase as State["phase"]].length).toBeGreaterThan(0);
  });

  it("maps the start, picker and manual form", () => {
    const s0 = run([{ type: "session_loaded", session: session() }]);
    expect(screenFor(s0, ctx)).toBe("start");
    expect(screenFor(initialState, ctx)).toBe("loading");
    const manual = run([{ type: "choose_path", path: "manual" }], s0);
    expect(screenFor(manual, ctx)).toBe("pay_with");
    expect(screenFor(reducer(manual, { type: "options_loaded", options: [] }), ctx)).toBe("no_options");
    const picked = run(
      [
        { type: "options_loaded", options: [opt()] },
        { type: "select_option", option: opt() },
      ],
      manual,
    );
    expect(screenFor(picked, ctx)).toBe("pay_with");
    expect(screenFor(picked, { ...ctx, manualForm: true })).toBe("send_from_another_wallet");
    expect(screenFor(reducer(picked, { type: "confirm" }), ctx)).toBe("verifying");
    expect(screenFor(run([{ type: "choose_path", path: "wallet" }], s0), ctx)).toBe("connect_wallet");
    expect(screenFor(reducer(s0, { type: "blocked", reason: "geo_blocked" }), ctx)).toBe("blocked");
  });

  it("maps the wallet review variants", () => {
    const s = run(toPayWallet);
    expect(s.phase).toBe("pay_wallet");
    expect(screenFor(s, ctx)).toBe("review");
    expect(screenFor(s, { ...ctx, totalChanged: true })).toBe("review_updated");
    expect(screenFor(s, { ...ctx, busy: true })).toBe("approve_in_wallet");
    expect(screenFor(reducer(s, { type: "error", error: { code: "wallet_rejected" } }), ctx)).toBe("not_approved");
    expect(screenFor(reducer(s, { type: "error", error: { code: INSUFFICIENT_FUNDS } }), ctx)).toBe("not_enough_funds");
    const test = { ...s, session: session({ livemode: false }) };
    expect(screenFor(test, ctx)).toBe("test_payment");
    expect(screenFor({ ...s, verified: null }, ctx)).toBe("verifying");
    expect(screenFor(reducer(s, { type: "deadline_passed" }), ctx)).toBe("quote_expired");
  });

  it("maps manual, processing, results and returns", () => {
    const base = run([{ type: "session_loaded", session: session() }]);
    const pay: State = { ...base, phase: "pay_manual", path: "manual", verified: verified(), attempt: attempt() };
    expect(screenFor(pay, ctx)).toBe("send_manual");
    expect(screenFor({ ...pay, verified: null }, ctx)).toBe("verifying");
    expect(screenFor({ ...pay, phase: "needs_top_up" }, ctx)).toBe("received_less");
    expect(screenFor({ ...pay, phase: "needs_top_up", verified: null }, ctx)).toBe("verifying");
    expect(screenFor({ ...pay, phase: "expired_address" }, ctx)).toBe("address_expired");
    expect(screenFor({ ...pay, phase: "verify_failed" }, ctx)).toBe("verify_failed");
    const proc: State = { ...pay, phase: "processing" };
    expect(screenFor(proc, ctx)).toBe("waiting");
    const detected = { ...proc, attempt: attempt({ status: "deposit_detected" }) };
    expect(screenFor(detected, ctx)).toBe("confirming");
    expect(screenFor(detected, { ...ctx, slow: true })).toBe("still_confirming");
    expect(screenFor({ ...pay, phase: "review" }, ctx)).toBe("under_review");
    expect(screenFor({ ...pay, phase: "succeeded" }, ctx)).toBe("complete");
    const ref = (status: string, depositSeen: boolean): State => ({
      ...pay,
      phase: "refunded",
      depositSeen,
      attempt: attempt({ status: status as never }),
    });
    expect(screenFor(ref("refunded", true), ctx)).toBe("returned");
    expect(screenFor(ref("expired_unpaid", false), ctx)).toBe("quote_expired");
    expect(screenFor(ref("failed", true), ctx)).toBe("being_returned");
    expect(screenFor(ref("failed", false), ctx)).toBe("not_completed");
  });
});

describe("machine: change, use_manual, depositSeen", () => {
  it("Change on review goes back to the picker without instructions", () => {
    const s = reducer(run(toPayWallet), { type: "change" });
    expect(s.phase).toBe("choose_asset");
    expect(s.verified).toBeNull();
    expect(s.option).toBeNull();
    expect(reducer(run([{ type: "session_loaded", session: live }]), { type: "change" }).phase).toBe("choose_path");
    const closed = { ...run(toPayWallet), session: session({ status: "expired" }) };
    expect(reducer(closed, { type: "change" }).phase).toBe("blocked");
  });

  it("Send from another wallet switches the wallet path to the manual path", () => {
    const s = reducer(run(toPayWallet), { type: "use_manual" });
    expect(s).toMatchObject({ phase: "choose_asset", path: "manual", wallet: null, verified: null, options: null });
    const manual = run([
      { type: "session_loaded", session: live },
      { type: "choose_path", path: "manual" },
    ]);
    expect(reducer(manual, { type: "use_manual" })).toBe(manual);
    const closed = { ...run(toPayWallet), session: session({ status: "expired" }) };
    expect(reducer(closed, { type: "use_manual" }).phase).toBe("blocked");
  });

  it("remembers a detected deposit for the current attempt", () => {
    let s = run(toPayWallet);
    expect(s.depositSeen).toBe(false);
    s = reducer(s, { type: "stream_attempt", attempt: attempt({ livemode: true, status: "deposit_detected" }) });
    expect(s.depositSeen).toBe(true);
    s = reducer(s, { type: "stream_attempt", attempt: attempt({ livemode: true, status: "failed" }) });
    expect(s).toMatchObject({ phase: "refunded", depositSeen: true });
    const resumed = reducer(initialState, {
      type: "session_loaded",
      session: session({ attempt: attempt({ status: "settling", attestation_ticket: null }) }),
    });
    expect(resumed.depositSeen).toBe(true);
  });
});

describe("wallet recipes with PaymentOption.token (CR-15-06)", () => {
  const token = "0x1111111111111111111111111111111111111111";
  it("uses a typed token for assets the id does not describe", () => {
    expect(walletAsset("nep141:foo.near", "eip155:10", { standard: "erc20", address: token })).toEqual({
      kind: "evm_erc20",
      chainId: 10,
      token,
    });
    expect(walletAsset("nep141:foo.near", "eip155:10", { standard: "native", address: null })).toEqual({
      kind: "evm_native",
      chainId: 10,
    });
    expect(walletAsset("nep245:x", "near:mainnet", { standard: "nep141", address: "usdt.tether-token.near" })).toEqual({
      kind: "near_nep141",
      token: "usdt.tether-token.near",
    });
    expect(walletAsset("nep245:x", "near:mainnet", { standard: "nep141", address: "wrap.near" })).toEqual({
      kind: "near_wrap",
      token: "wrap.near",
    });
  });

  it("refuses unusable or contradicting tokens (fail closed)", () => {
    expect(walletAsset("nep141:foo.near", "eip155:10", { standard: "erc20", address: "0x12" })).toBeNull();
    expect(walletAsset("nep141:foo.near", "eip155:10", { standard: "spl", address: "abc" })).toBeNull();
    expect(walletAsset("nep141:foo.near", "eip155:10", { standard: "other", address: null })).toBeNull();
    expect(walletAsset("nep245:x", "near:mainnet", { standard: "nep141", address: "BAD ACCOUNT" })).toBeNull();
    expect(walletAsset("nep245:x", "near:mainnet", { standard: "erc20", address: token })).toBeNull();
    expect(walletAsset("x", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", { standard: "spl", address: "a" })).toBeNull();
    expect(walletAsset(USDC_BASE, "eip155:8453", { standard: "erc20", address: token })).toBeNull();
    expect(walletAsset("x", "foo:bar", { standard: "erc20", address: token })).toBeNull();
  });

  it("keeps the derived recipe when the token agrees or is null/absent", () => {
    const usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    const derived = { kind: "evm_erc20", chainId: 8453, token: usdc };
    expect(
      walletAsset(USDC_BASE, "eip155:8453", { standard: "erc20", address: usdc.toUpperCase().replace("0X", "0x") }),
    ).toEqual(derived);
    expect(walletAsset(USDC_BASE, "eip155:8453", null)).toEqual(derived);
    expect(walletAsset(USDC_BASE, "eip155:8453")).toEqual(derived);
  });

  it("offers non-omft EVM tokens on the wallet path when typed", () => {
    const op = opt({
      origin_asset_id: "nep141:op-usdc.near",
      chain: "eip155:10",
      token: { standard: "erc20", address: token },
    });
    expect(payableOptions([op], "wallet", "evm")).toHaveLength(1);
    expect(payableOptions([{ ...op, token: null }], "wallet", "evm")).toHaveLength(0);
  });
});

describe("Attestation.asset (CR-15-07)", () => {
  const [routeVec, intentsVec] = sentinelVectors.valid as [
    (typeof sentinelVectors.valid)[number],
    (typeof sentinelVectors.valid)[number],
  ];
  const withAsset = (signed: typeof routeVec.signed, assetId: string) =>
    signAttestation({
      ...JSON.parse(JSON.stringify(signed.attestation)),
      asset: { asset_id: assetId, symbol: "USDC", decimals: 6 },
    });

  it("accepts an attested asset that is the paid asset and rejects another one", () => {
    const att = routeVec.signed.attestation as { deposit: { origin_asset_id: string } };
    const ok = verifyAttestation(
      withAsset(routeVec.signed, att.deposit.origin_asset_id),
      PINNED,
      attemptFor(routeVec.signed),
      VECTOR_TIME,
    );
    expect(ok.ok).toBe(true);
    const bad = verifyAttestation(
      withAsset(routeVec.signed, "nep141:other.near"),
      PINNED,
      attemptFor(routeVec.signed),
      VECTOR_TIME,
    );
    expect(bad).toEqual({ ok: false, reason: "field_mismatch", field: "asset" });
    const early = Date.parse("2026-11-05T10:00:30.000Z");
    const intentsBad = verifyAttestation(
      withAsset(intentsVec.signed, "nep141:other.near"),
      PINNED,
      attemptFor(intentsVec.signed),
      early,
    );
    expect(intentsBad).toEqual({ ok: false, reason: "field_mismatch", field: "asset" });
  });

  it("prefers attested decimals/symbol for display, else the options", () => {
    const att = { asset: { asset_id: USDC_BASE, symbol: "USDC.e", decimals: 6 } } as never;
    expect(assetMeta(USDC_BASE, att, [opt({ symbol: "USDC" })])).toMatchObject({
      symbol: "USDC.e",
      source: "attested",
    });
    expect(assetMeta(USDC_NEAR, att, [null, opt({ origin_asset_id: USDC_NEAR })])).toMatchObject({ source: "options" });
    expect(assetMeta("nep141:none.near", null, [opt()])).toBeNull();
  });
});

describe("display helpers", () => {
  it("totals and fees from the attestation", () => {
    const route = { kind: "route_quote", deposit: { amount_in: "2005013", origin_asset_id: USDC_BASE } } as never;
    expect(totalToSend(route)).toBe("2005013");
    expect(statedFee(route)).toBeNull();
    expect(paidAssetId(route)).toBe(USDC_BASE);
    const intents = {
      kind: "intents_transfer",
      requirement: { amount: "2000000", fee_amount: "6000", token: USDC_NEAR },
    } as never;
    expect(totalToSend(intents)).toBe("2006000");
    expect(statedFee(intents)).toBe("6000");
    expect(paidAssetId(intents)).toBe(USDC_NEAR);
    expect(totalToSend({ kind: "intents_transfer" } as never)).toBeNull();
    expect(paidAssetId({ kind: "route_quote" } as never)).toBeNull();
  });

  it("prices in fiat and assets without floats", () => {
    expect(priceMoney({ amount: 4900, currency: "usd", asset_id: null }, null)).toEqual({
      amount: "4900",
      decimals: 2,
      symbol: "$",
      minFraction: 2,
    });
    expect(priceMoney({ amount: 500, currency: "jpy", asset_id: null }, null)?.decimals).toBe(0);
    expect(priceMoney({ amount: 1.5, currency: "usd", asset_id: null }, null)).toBeNull();
    const meta = { asset_id: USDC_NEAR, symbol: "USDC", decimals: 6, source: "options" as const };
    expect(priceMoney({ amount: "2000000", currency: "asset", asset_id: USDC_NEAR }, meta)?.symbol).toBe("USDC");
    expect(priceMoney({ amount: "2000000", currency: "asset", asset_id: USDC_NEAR }, null)).toBeNull();
    expect(currencySymbol("eur")).toBe("€");
    expect(currencySymbol("zzz")).toBe("ZZZ");
  });

  it("search and network filter", () => {
    const list = [
      opt(),
      opt({ origin_asset_id: USDC_NEAR, chain: "near:mainnet" }),
      opt({ method: "intents_transfer", origin_asset_id: USDC_NEAR, chain: "near:mainnet" }),
    ];
    expect(networksOf(list).map((n) => n.label)).toEqual(["Base", "NEAR", "NEAR Intents"]);
    expect(filterOptions(list, "usdc on base", null)).toHaveLength(1);
    expect(filterOptions(list, "", "intents")).toHaveLength(1);
    expect(filterOptions(list, "doge", null)).toHaveLength(0);
    expect(filterOptions(list, "  ", null)).toHaveLength(3);
    expect(optionTitle(list[2] as Option)).toBe("USDC · NEAR Intents");
  });

  it("only follows a link session whose secret belongs to it", () => {
    expect(linkSessionPath(SESSION_ID, SECRET)).toBe(`/c/${SESSION_ID}#${SECRET}`);
    expect(linkSessionPath(SESSION_ID, `cs_01jbz9k3m4n5p6q7r8s9t0v1zz_secret_${"A".repeat(32)}`)).toBeNull();
    expect(linkSessionPath("cs_bad", SECRET)).toBeNull();
  });
});
