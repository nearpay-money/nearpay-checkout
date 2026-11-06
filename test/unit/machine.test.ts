import { describe, expect, it } from "vitest";
import { type Event, hasLiveInstructions, initialState, type Option, reducer, type State } from "../../src/app/machine";
import type { VerifiedInstructions } from "../../src/lib/integrity/verify";
import { attempt, session } from "../support/sessions";

const run = (events: Event[], from: State = initialState): State => events.reduce(reducer, from);
const option: Option = {
  method: "route_quote",
  origin_asset_id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  chain: "eip155:8453",
  symbol: "USDC",
  decimals: 6,
  estimated_amount_in: "2005013",
  route_class: "stable_pair",
  min_deadline_s: 300,
  available: true,
  reason: null,
};
const verified = (attemptId = attempt().id): VerifiedInstructions =>
  ({
    attestation: { attempt_id: attemptId, kind: "route_quote" },
    kid: "k",
    validUntil: 1,
  }) as unknown as VerifiedInstructions;

const manualToVerifying: Event[] = [
  { type: "session_loaded", session: session() },
  { type: "choose_path", path: "manual" },
  { type: "options_loaded", options: [option] },
  { type: "select_option", option },
  { type: "confirm" },
  { type: "attempt_created", attempt: attempt() },
];

describe("checkout state machine (§4)", () => {
  it("happy manual path", () => {
    let s = run(manualToVerifying);
    expect(s.phase).toBe("verifying");
    s = reducer(s, { type: "verified", verified: verified() });
    expect(s.phase).toBe("pay_manual");
    s = reducer(s, { type: "paid" });
    expect(s.phase).toBe("processing");
    s = reducer(s, {
      type: "stream_intent",
      intent: { id: "pi_01jbz9k3m4n5p6q7r8s9t0v1w2", status: "succeeded", amount_settled: "2000000", late: false },
    });
    expect(s.phase).toBe("succeeded");
    expect(s.intent?.id).toBe("pi_01jbz9k3m4n5p6q7r8s9t0v1w2");
  });

  it("wallet path goes through connect_wallet to pay_wallet", () => {
    let s = run([
      { type: "session_loaded", session: session() },
      { type: "choose_path", path: "wallet" },
    ]);
    expect(s.phase).toBe("connect_wallet");
    s = reducer(s, { type: "wallet_connected", wallet: { family: "evm", address: "0x1", label: "Mock" } });
    expect(s.phase).toBe("choose_asset");
    s = run(
      [
        { type: "select_option", option },
        { type: "confirm" },
        { type: "attempt_created", attempt: attempt() },
        { type: "verified", verified: verified() },
      ],
      s,
    );
    expect(s.phase).toBe("pay_wallet");
  });

  it("never shows instructions without verification", () => {
    const s = run(manualToVerifying);
    expect(reducer(s, { type: "verify_failed", reason: "bad_signature" })).toMatchObject({
      phase: "verify_failed",
      verified: null,
      verifyFailure: { reason: "bad_signature" },
    });
    expect(reducer(s, { type: "verified", verified: verified("pa_01jbz9k3m4n5p6q7r8s9t0v1w9") }).phase).toBe(
      "verifying",
    );
    expect(reducer(s, { type: "paid" }).phase).toBe("verifying");
    const failed = reducer(s, { type: "verify_failed", reason: "field_mismatch", field: "address" });
    expect(failed.verifyFailure).toEqual({ reason: "field_mismatch", field: "address" });
    expect(reducer(failed, { type: "verified", verified: verified() }).phase).toBe("verify_failed");
  });

  it("retry creates a new attempt with the replaced notice", () => {
    let s = run([...manualToVerifying, { type: "verify_failed", reason: "x" }, { type: "retry" }]);
    expect(s.phase).toBe("choose_asset");
    s = run(
      [
        { type: "select_option", option },
        { type: "confirm" },
        { type: "attempt_created", attempt: attempt({ id: "pa_01jbz9k3m4n5p6q7r8s9t0v1w3" }) },
      ],
      s,
    );
    expect(s.replacedAttempt).toBe(true);
  });

  it("deadline replaces the address", () => {
    const s = run([...manualToVerifying, { type: "verified", verified: verified() }, { type: "deadline_passed" }]);
    expect(s).toMatchObject({ phase: "expired_address", verified: null });
    expect(reducer(s, { type: "retry" }).phase).toBe("choose_asset");
    expect(reducer(run(manualToVerifying), { type: "deadline_passed" }).phase).toBe("verifying");
  });

  it("follows the attempt through the stream", () => {
    const shown = run([...manualToVerifying, { type: "verified", verified: verified() }]);
    expect(reducer(shown, { type: "stream_attempt", attempt: attempt({ status: "deposit_detected" }) }).phase).toBe(
      "processing",
    );
    expect(reducer(shown, { type: "stream_attempt", attempt: attempt({ status: "incomplete_deposit" }) }).phase).toBe(
      "needs_top_up",
    );
    expect(reducer(shown, { type: "stream_attempt", attempt: attempt({ status: "held" }) }).phase).toBe("review");
    expect(reducer(shown, { type: "stream_attempt", attempt: attempt({ status: "refunded" }) }).phase).toBe("refunded");
    expect(reducer(shown, { type: "stream_attempt", attempt: attempt({ status: "expired_unpaid" }) }).phase).toBe(
      "expired_address",
    );
    expect(reducer(shown, { type: "stream_attempt", attempt: attempt({ visible: false }) }).phase).toBe(
      "expired_address",
    );
    expect(
      reducer(shown, {
        type: "stream_attempt",
        attempt: attempt({ id: "pa_01jbz9k3m4n5p6q7r8s9t0v1w9", status: "succeeded" }),
      }).phase,
    ).toBe("pay_manual");
    const processing = reducer(shown, { type: "paid" });
    expect(reducer(processing, { type: "stream_attempt", attempt: attempt({ status: "expired_unpaid" }) }).phase).toBe(
      "refunded",
    );
    expect(
      reducer(processing, { type: "stream_attempt", attempt: attempt({ status: "incomplete_deposit" }) }).phase,
    ).toBe("needs_top_up");
    const unverified = run(manualToVerifying);
    expect(
      reducer(unverified, { type: "stream_attempt", attempt: attempt({ status: "incomplete_deposit" }) }).phase,
    ).toBe("processing");
    expect(
      reducer(processing, { type: "stream_attempt", attempt: attempt({ status: "awaiting_deposit" }) }).phase,
    ).toBe("processing");
    const done = reducer(processing, {
      type: "stream_intent",
      intent: { id: "pi_01jbz9k3m4n5p6q7r8s9t0v1w2", status: "succeeded", amount_settled: "1", late: false },
    });
    expect(reducer(done, { type: "stream_attempt", attempt: attempt({ status: "refunded" }) }).phase).toBe("succeeded");
  });

  it("follows the intent through the stream", () => {
    const shown = run([...manualToVerifying, { type: "verified", verified: verified() }]);
    const i = (status: "processing" | "requires_review" | "canceled" | "expired" | "requires_payment") => ({
      id: "pi_01jbz9k3m4n5p6q7r8s9t0v1w2" as const,
      status,
      amount_settled: "0",
      late: false,
    });
    expect(reducer(shown, { type: "stream_intent", intent: i("processing") }).phase).toBe("processing");
    expect(reducer(shown, { type: "stream_intent", intent: i("requires_review") }).phase).toBe("review");
    expect(reducer(shown, { type: "stream_intent", intent: i("canceled") })).toMatchObject({
      phase: "blocked",
      blockReason: "session_canceled",
    });
    expect(reducer(shown, { type: "stream_intent", intent: i("expired") })).toMatchObject({
      phase: "blocked",
      blockReason: "session_expired",
    });
    expect(reducer(shown, { type: "stream_intent", intent: i("requires_payment") }).phase).toBe("pay_manual");
    expect(reducer(initialState, { type: "stream_intent", intent: i("processing") }).phase).toBe("loading");
    const choose = run([{ type: "session_loaded", session: session() }]);
    expect(reducer(choose, { type: "stream_intent", intent: i("processing") }).phase).toBe("choose_path");
  });

  it("follows session snapshots (polling fallback)", () => {
    const shown = run([...manualToVerifying, { type: "verified", verified: verified() }]);
    expect(
      reducer(shown, {
        type: "stream_session",
        session: session({ attempt: attempt({ status: "settling" }), intent_status: "processing" }),
      }).phase,
    ).toBe("processing");
    expect(
      reducer(shown, {
        type: "stream_session",
        session: session({ attempt: attempt({ id: "pa_01jbz9k3m4n5p6q7r8s9t0v1w9" }) }),
      }).phase,
    ).toBe("expired_address");
    expect(
      reducer(shown, { type: "stream_session", session: session({ status: "complete", intent_status: "succeeded" }) })
        .phase,
    ).toBe("succeeded");
    expect(
      reducer(shown, {
        type: "stream_session",
        session: session({ status: "expired", intent_status: "requires_payment" }),
      }).phase,
    ).toBe("blocked");
    expect(reducer(shown, { type: "stream_session", session: session() }).phase).toBe("pay_manual");
  });

  it("resumes a loaded session", () => {
    const load = (over: Parameters<typeof session>[0]) =>
      reducer(initialState, { type: "session_loaded", session: session(over) });
    expect(load({}).phase).toBe("choose_path");
    expect(load({ status: "complete", intent_status: "succeeded" }).phase).toBe("succeeded");
    expect(load({ status: "complete", intent_status: "requires_review" }).phase).toBe("review");
    expect(load({ intent_status: "requires_review" }).phase).toBe("review");
    expect(load({ intent_status: "canceled", status: "expired" }).blockReason).toBe("session_canceled");
    expect(load({ status: "expired", intent_status: "expired" }).blockReason).toBe("session_expired");
    expect(load({ status: "expiring" }).blockReason).toBe("session_expired");
    expect(load({ attempt: attempt() })).toMatchObject({ phase: "verifying", path: "manual" });
    expect(load({ attempt: attempt({ status: "settling" }) }).phase).toBe("processing");
    expect(load({ status: "expiring", attempt: attempt({ status: "deposit_detected" }) }).phase).toBe("processing");
    expect(load({ attempt: attempt({ status: "held" }) }).phase).toBe("review");
    expect(load({ attempt: attempt({ status: "quoting", deposit: null, attestation_ticket: null }) }).phase).toBe(
      "confirming",
    );
    expect(load({ attempt: attempt({ status: "refunded" }) }).phase).toBe("refunded");
    expect(
      load({ attempt: attempt({ method: "intents_transfer", deposit: null, intents_requirement: null }) }).phase,
    ).toBe("choose_path");
  });

  it("maps attempt creation errors", () => {
    const confirming = run(manualToVerifying.slice(0, 5));
    expect(reducer(confirming, { type: "attempt_failed", error: { code: "route_too_slow" } })).toMatchObject({
      phase: "choose_asset",
      error: { code: "route_too_slow" },
    });
    expect(reducer(confirming, { type: "attempt_failed", error: { code: "geo_blocked" } }).blockReason).toBe(
      "geo_blocked",
    );
    expect(reducer(confirming, { type: "attempt_failed", error: { code: "screening_blocked" } }).blockReason).toBe(
      "screening_blocked",
    );
    expect(reducer(confirming, { type: "attempt_failed", error: { code: "session_not_open" } }).blockReason).toBe(
      "session_expired",
    );
    const choose = run(manualToVerifying.slice(0, 4));
    expect(reducer(choose, { type: "attempt_failed", error: { code: "x" } })).toMatchObject({
      phase: "choose_asset",
      error: { code: "x" },
    });
    expect(
      reducer(confirming, {
        type: "attempt_created",
        attempt: attempt({ status: "quoting", deposit: null, attestation_ticket: null }),
      }).phase,
    ).toBe("confirming");
  });

  it("ignores events out of phase and handles back/error/block", () => {
    const loaded = run([{ type: "session_loaded", session: session() }]);
    expect(
      reducer(loaded, { type: "wallet_connected", wallet: { family: "near", address: "a.near", label: "x" } }),
    ).toBe(loaded);
    expect(reducer(loaded, { type: "confirm" })).toBe(loaded);
    expect(reducer(loaded, { type: "attempt_created", attempt: attempt() })).toBe(loaded);
    expect(reducer(loaded, { type: "retry" })).toBe(loaded);
    expect(reducer(loaded, { type: "back" })).toBe(loaded);
    expect(reducer(loaded, { type: "select_option", option })).toBe(loaded);
    const choose = run([{ type: "choose_path", path: "manual" }], loaded);
    expect(reducer(choose, { type: "choose_path", path: "wallet" })).toBe(choose);
    expect(reducer(choose, { type: "select_option", option: { ...option, available: false } })).toBe(choose);
    expect(reducer(choose, { type: "back" }).phase).toBe("choose_path");
    expect(reducer(choose, { type: "error", error: { code: "x" } }).error).toEqual({ code: "x" });
    expect(reducer(choose, { type: "blocked", reason: "origin_mismatch" })).toMatchObject({
      phase: "blocked",
      blockReason: "origin_mismatch",
    });
    const failed = run([...manualToVerifying, { type: "verify_failed", reason: "x" }]);
    const closed = { ...failed, session: session({ status: "expiring" }) };
    expect(reducer(closed, { type: "retry" }).phase).toBe("blocked");
    const noPath = { ...failed, path: null };
    expect(reducer(noPath, { type: "retry" }).phase).toBe("choose_path");
  });

  it("needs_top_up after verification of an incomplete deposit (resume)", () => {
    const s = reducer(initialState, {
      type: "session_loaded",
      session: session({ attempt: attempt({ status: "incomplete_deposit" }) }),
    });
    expect(s.phase).toBe("verifying");
    expect(reducer(s, { type: "verified", verified: verified() }).phase).toBe("needs_top_up");
  });

  it("knows when instructions are live", () => {
    expect(hasLiveInstructions(null)).toBe(false);
    expect(hasLiveInstructions(attempt())).toBe(true);
    expect(hasLiveInstructions(attempt({ attestation_ticket: null }))).toBe(false);
    expect(hasLiveInstructions(attempt({ status: "settling" }))).toBe(false);
    expect(hasLiveInstructions(attempt({ method: "intents_transfer" }))).toBe(false);
  });
});
