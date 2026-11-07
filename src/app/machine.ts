/**
 * Checkout UI state machine (lld/checkout-and-js.md §4) as a pure reducer. Side effects (API calls,
 * sentinel verification, wallets, the status stream) live in `useCheckout`; they report back through
 * these events. The machine never shows instructions without a successful verification: the only way
 * into `pay_wallet` / `pay_manual` / `needs_top_up` is the `verified` event for the current attempt.
 */
import type { PaymentOption } from "@nearpay/spec";
import type { z } from "zod";
import type { AttemptSnapshot, IntentSnapshot, SessionSnapshot } from "../features/status-stream/stream";
import type { VerifiedInstructions, VerifyFailure } from "../lib/integrity/verify";

export type Option = z.output<typeof PaymentOption>;
export type Path = "wallet" | "manual";

export type Phase =
  | "loading"
  | "blocked"
  | "choose_path"
  | "connect_wallet"
  | "choose_asset"
  | "confirming"
  | "verifying"
  | "verify_failed"
  | "pay_wallet"
  | "pay_manual"
  | "expired_address"
  | "processing"
  | "needs_top_up"
  | "refunded"
  | "review"
  | "succeeded";

export type BlockReason =
  | "invalid_link"
  | "secret_invalid"
  | "session_expired"
  | "session_canceled"
  | "origin_mismatch"
  | "not_framed"
  | "geo_blocked"
  | "screening_blocked"
  | "load_failed";

export interface ConnectedWallet {
  readonly family: "evm" | "near";
  readonly address: string;
  readonly label: string;
}

export interface UiError {
  readonly code: string;
  readonly param?: string | null;
}

export interface State {
  readonly phase: Phase;
  readonly blockReason: BlockReason | null;
  readonly session: SessionSnapshot | null;
  readonly attempt: AttemptSnapshot | null;
  readonly intent: IntentSnapshot | null;
  readonly verified: VerifiedInstructions | null;
  readonly verifyFailure: { readonly reason: VerifyFailure | string; readonly field?: string } | null;
  readonly path: Path | null;
  readonly wallet: ConnectedWallet | null;
  readonly options: readonly Option[] | null;
  readonly option: Option | null;
  /** A newer attempt replaced one whose instructions were shown ("don't send again"). */
  readonly replacedAttempt: boolean;
  /** The current attempt was seen with a deposit in flight in this page load (failures then mean "being returned"). */
  readonly depositSeen: boolean;
  readonly error: UiError | null;
}

export type Event =
  | { readonly type: "session_loaded"; readonly session: SessionSnapshot }
  | { readonly type: "blocked"; readonly reason: BlockReason }
  | { readonly type: "choose_path"; readonly path: Path }
  | { readonly type: "wallet_connected"; readonly wallet: ConnectedWallet }
  | { readonly type: "options_loaded"; readonly options: readonly Option[] }
  | { readonly type: "select_option"; readonly option: Option }
  | { readonly type: "confirm" }
  | { readonly type: "attempt_created"; readonly attempt: AttemptSnapshot }
  | { readonly type: "attempt_failed"; readonly error: UiError }
  | { readonly type: "verified"; readonly verified: VerifiedInstructions }
  | { readonly type: "verify_failed"; readonly reason: VerifyFailure | string; readonly field?: string }
  | { readonly type: "paid" }
  | { readonly type: "deadline_passed" }
  | { readonly type: "retry" }
  | { readonly type: "back" }
  | { readonly type: "change" }
  | { readonly type: "use_manual" }
  | { readonly type: "error"; readonly error: UiError | null }
  | { readonly type: "stream_session"; readonly session: SessionSnapshot }
  | { readonly type: "stream_attempt"; readonly attempt: AttemptSnapshot }
  | { readonly type: "stream_intent"; readonly intent: IntentSnapshot };

export const initialState: State = {
  phase: "loading",
  blockReason: null,
  session: null,
  attempt: null,
  intent: null,
  verified: null,
  verifyFailure: null,
  path: null,
  wallet: null,
  options: null,
  option: null,
  replacedAttempt: false,
  depositSeen: false,
  error: null,
};

const IN_FLIGHT = new Set(["deposit_detected", "settling", "verifying"]);
const FAILED = new Set(["refunded", "failed"]);
/** Phases in which instructions are on screen (or about to be). */
const SHOWING = new Set<Phase>(["verifying", "pay_wallet", "pay_manual", "needs_top_up"]);
const FINAL = new Set<Phase>(["succeeded", "blocked"]);
/** Attempt statuses that mean the payer's funds reached the route. */
const DEPOSITED = new Set(["deposit_detected", "incomplete_deposit", "settling", "verifying", "held", "succeeded"]);

/** Instructions still live on an attempt (deposit or requirement, with a sentinel ticket). */
export function hasLiveInstructions(a: AttemptSnapshot | null): boolean {
  if (!a?.visible || !a.attestation_ticket) return false;
  if (a.status !== "awaiting_deposit" && a.status !== "incomplete_deposit") return false;
  return a.method === "route_quote" ? a.deposit !== null : a.intents_requirement !== null;
}

function block(s: State, reason: BlockReason): State {
  return { ...s, phase: "blocked", blockReason: reason, verified: null };
}

/** Where a freshly loaded session resumes (reload, second tab, deep link). */
export function resume(s: State, session: SessionSnapshot): State {
  const base: State = {
    ...s,
    session,
    attempt: session.attempt,
    depositSeen: session.attempt !== null && DEPOSITED.has(session.attempt.status),
    error: null,
  };
  if (session.intent_status === "succeeded" || session.status === "complete") {
    return session.intent_status === "requires_review" ? { ...base, phase: "review" } : { ...base, phase: "succeeded" };
  }
  if (session.intent_status === "requires_review") return { ...base, phase: "review" };
  if (session.intent_status === "canceled") return block(base, "session_canceled");
  const a = session.attempt;
  if (a?.visible) {
    if (a.status === "held") return { ...base, phase: "review" };
    if (IN_FLIGHT.has(a.status) || a.status === "succeeded") return { ...base, phase: "processing" };
    if (a.status === "quoting") return { ...base, phase: "confirming", path: "manual" };
    if (hasLiveInstructions(a) && a.method === "route_quote") return { ...base, phase: "verifying", path: "manual" };
    if (session.status === "open" && (FAILED.has(a.status) || a.status === "expired_unpaid")) {
      return { ...base, phase: "refunded" };
    }
  }
  if (session.status === "open") return { ...base, attempt: null, phase: "choose_path" };
  return block(base, "session_expired");
}

function applyAttempt(s: State, a: AttemptSnapshot): State {
  if (!s.attempt || a.id !== s.attempt.id) return s;
  const next: State = { ...s, attempt: a, depositSeen: s.depositSeen || DEPOSITED.has(a.status) };
  if (FINAL.has(s.phase) || s.phase === "review") return next;
  if (!a.visible && SHOWING.has(s.phase)) return { ...next, phase: "expired_address", verified: null };
  if (a.status === "held") return { ...next, phase: "review" };
  if (IN_FLIGHT.has(a.status) || a.status === "succeeded") return { ...next, phase: "processing" };
  if (a.status === "incomplete_deposit") {
    return next.verified ? { ...next, phase: "needs_top_up" } : { ...next, phase: "processing" };
  }
  if (a.status === "expired_unpaid") {
    return s.phase === "processing"
      ? { ...next, phase: "refunded" }
      : { ...next, phase: "expired_address", verified: null };
  }
  if (FAILED.has(a.status)) return { ...next, phase: "refunded", verified: null };
  return next;
}

function applyIntentStatus(s: State, status: IntentSnapshot["status"]): State {
  if (s.phase === "blocked" || s.phase === "loading") return s;
  switch (status) {
    case "succeeded":
      return { ...s, phase: "succeeded", verified: null };
    case "requires_review":
      return { ...s, phase: "review", verified: null };
    case "canceled":
      return s.phase === "succeeded" ? s : block(s, "session_canceled");
    case "expired":
      return s.phase === "succeeded" || s.phase === "review" ? s : block(s, "session_expired");
    case "processing":
      return SHOWING.has(s.phase) || s.phase === "expired_address" ? { ...s, phase: "processing" } : s;
    default:
      return s;
  }
}

function applyIntent(s: State, i: IntentSnapshot): State {
  return applyIntentStatus({ ...s, intent: i }, i.status);
}

function applySession(s: State, session: SessionSnapshot): State {
  let next: State = { ...s, session };
  if (session.attempt && s.attempt && session.attempt.id === s.attempt.id) next = applyAttempt(next, session.attempt);
  else if (s.attempt && SHOWING.has(s.phase) && session.attempt && session.attempt.id !== s.attempt.id) {
    // Another tab created a newer attempt: this one is no longer the visible one.
    next = { ...next, phase: "expired_address", verified: null };
  }
  if (session.intent_status !== "requires_payment") next = applyIntentStatus(next, session.intent_status);
  if (
    session.status === "expired" &&
    !FINAL.has(next.phase) &&
    next.phase !== "review" &&
    next.phase !== "processing"
  ) {
    next = block(next, "session_expired");
  }
  return next;
}

export function reducer(s: State, e: Event): State {
  switch (e.type) {
    case "session_loaded":
      return resume(s, e.session);
    case "blocked":
      return block(s, e.reason);
    case "choose_path":
      if (s.phase !== "choose_path") return s;
      return e.path === "wallet"
        ? { ...s, path: "wallet", phase: "connect_wallet", error: null }
        : { ...s, path: "manual", phase: "choose_asset", options: null, option: null, error: null };
    case "wallet_connected":
      if (s.phase !== "connect_wallet") return s;
      return { ...s, wallet: e.wallet, phase: "choose_asset", options: null, option: null, error: null };
    case "options_loaded":
      return { ...s, options: e.options };
    case "select_option":
      return s.phase === "choose_asset" && e.option.available ? { ...s, option: e.option, error: null } : s;
    case "confirm":
      return s.phase === "choose_asset" && s.option ? { ...s, phase: "confirming", error: null } : s;
    case "attempt_created": {
      if (s.phase !== "confirming") return s;
      const replaced = s.attempt !== null && s.attempt.id !== e.attempt.id;
      const next: State = {
        ...s,
        attempt: e.attempt,
        verified: null,
        verifyFailure: null,
        replacedAttempt: replaced,
        depositSeen: DEPOSITED.has(e.attempt.status),
      };
      return hasLiveInstructions(e.attempt) ? { ...next, phase: "verifying" } : next;
    }
    case "attempt_failed":
      if (e.error.code === "geo_blocked") return block(s, "geo_blocked");
      if (e.error.code === "screening_blocked") return block(s, "screening_blocked");
      if (e.error.code === "session_not_open") return block(s, "session_expired");
      return s.phase === "confirming" ? { ...s, phase: "choose_asset", error: e.error } : { ...s, error: e.error };
    case "verified":
      if (s.phase !== "verifying" || !s.attempt || e.verified.attestation.attempt_id !== s.attempt.id) return s;
      if (s.attempt.status === "incomplete_deposit") return { ...s, verified: e.verified, phase: "needs_top_up" };
      return {
        ...s,
        verified: e.verified,
        verifyFailure: null,
        phase: s.path === "wallet" ? "pay_wallet" : "pay_manual",
      };
    case "verify_failed":
      if (s.phase !== "verifying") return s;
      return {
        ...s,
        phase: "verify_failed",
        verified: null,
        verifyFailure: e.field ? { reason: e.reason, field: e.field } : { reason: e.reason },
      };
    case "paid":
      return s.phase === "pay_wallet" || s.phase === "pay_manual" ? { ...s, phase: "processing", error: null } : s;
    case "deadline_passed":
      return SHOWING.has(s.phase) && s.phase !== "verifying" ? { ...s, phase: "expired_address", verified: null } : s;
    case "retry":
      if (!["verify_failed", "expired_address", "refunded"].includes(s.phase)) return s;
      if (s.session?.status !== "open") return block(s, "session_expired");
      return {
        ...s,
        phase: s.path ? "choose_asset" : "choose_path",
        verified: null,
        verifyFailure: null,
        option: null,
        options: s.path ? s.options : null,
        error: null,
      };
    case "back":
      if (s.phase === "connect_wallet" || s.phase === "choose_asset") {
        return { ...s, phase: "choose_path", path: null, option: null, options: null, error: null };
      }
      return s;
    case "change":
      // "Change" on the review screen: hide the verified instructions and pick again. Creating the next
      // attempt hides this one server-side and shows the "don't send again" notice (§5.7).
      if (s.phase !== "pay_wallet" && s.phase !== "verify_failed") return s;
      if (s.session?.status !== "open") return block(s, "session_expired");
      return { ...s, phase: "choose_asset", verified: null, verifyFailure: null, option: null, error: null };
    case "use_manual":
      // "Send from another wallet" from the wallet path (desktop review, wallet list).
      if (!["connect_wallet", "choose_asset", "pay_wallet"].includes(s.phase) || s.path !== "wallet") return s;
      if (s.session?.status !== "open") return block(s, "session_expired");
      return {
        ...s,
        phase: "choose_asset",
        path: "manual",
        wallet: null,
        options: null,
        option: null,
        verified: null,
        verifyFailure: null,
        error: null,
      };
    case "error":
      return { ...s, error: e.error };
    case "stream_session":
      return applySession(s, e.session);
    case "stream_attempt":
      return applyAttempt(s, e.attempt);
    case "stream_intent":
      return applyIntent(s, e.intent);
  }
}
