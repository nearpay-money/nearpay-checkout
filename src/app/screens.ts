/**
 * Which Figma checkout frame renders a machine state (lld/checkout-and-js.md §4 → the owner's checkout
 * canvas, tiles a00–a03). Pure, so the mapping is unit-tested and every §4 state provably lands on a
 * design. Security decisions stay in the machine: a screen that shows instructions (`review`,
 * `send_manual`, `received_less`, `test_payment`, …) is only reachable from phases that require a
 * verified attestation.
 */
import { chainName } from "../lib/chains/chains";
import type { State } from "./machine";

export type ScreenId =
  | "loading" // skeleton of the frame
  | "blocked" // "This checkout can't be used" (session not open, origin, geo, screening)
  | "start" // a00 "Pay your way" / desktop embed "Choose how to pay"
  | "connect_wallet" // a00 "Connect a wallet"
  | "pay_with" // a00 "Pay with" (search, "All networks" → "Choose a network", list); a01 "No matching payment options"
  | "no_options" // a03 "Try another wallet or currency" (No payment options available)
  | "send_from_another_wallet" // a00 "Send from another wallet" (token card, refund address, network callout)
  | "verifying" // a02 "Verifying this checkout"
  | "verify_failed" // a02 "We couldn't verify this checkout"
  | "review" // a00 review (USDC · Base card, Purchase / Payment fees / Total to send, Pay, quote countdown); a02 desktop
  | "review_updated" // a02 "Review your updated total"
  | "test_payment" // a02 "Try a payment" (test mode, Simulate payment)
  | "approve_in_wallet" // a00 "Approve in your wallet"
  | "not_approved" // a01 "Payment not approved"
  | "not_enough_funds" // a01 "Not enough funds"
  | "tx_failed" // "Transaction failed in your wallet" (Solana send error, §11: Retry / Send from another wallet)
  | "send_manual" // a00/a01 "Send 49.49 USDC" (network callout, I'm sending on…, deposit address, exact amount)
  | "received_less" // a03 "We received less than expected"
  | "address_expired" // a03 "This address has expired"
  | "quote_expired" // a01 "Quote expired"
  | "waiting" // a00 "Confirming your payment" before a deposit is detected (honest copy: "Waiting for your payment")
  | "confirming" // a00 "Confirming your payment"
  | "still_confirming" // a01 "Still confirming"
  | "under_review" // a00 "Payment under review"
  | "complete" // a00 "Payment complete"
  | "being_returned" // a01 "Payment being returned"
  | "returned" // a03 "Your payment was returned"
  | "not_completed"; // a03 "Try another wallet or currency" (failed before any deposit)

export interface ScreenContext {
  /** Manual path: an option was picked and the refund form is open. */
  readonly manualForm: boolean;
  /** An effect is running (attempt creation, wallet request, simulation). */
  readonly busy: boolean;
  /** Processing has taken longer than the "still confirming" threshold. */
  readonly slow: boolean;
  /** A new quote changed the total of the previous one (wallet path re-quote). */
  readonly totalChanged: boolean;
}

const WAITING = new Set(["awaiting_deposit", "quoting"]);
export const INSUFFICIENT_FUNDS = "insufficient_funds";
/** The wallet could not send the transaction (not a rejection, not a balance error). */
export const TX_FAILED = "tx_failed";

export function screenFor(s: State, ctx: ScreenContext): ScreenId {
  switch (s.phase) {
    case "loading":
      return "loading";
    case "blocked":
      return "blocked";
    case "choose_path":
      return "start";
    case "connect_wallet":
      return "connect_wallet";
    case "choose_asset":
      if (s.options !== null && s.options.length === 0) return "no_options";
      return s.path === "manual" && s.option !== null && ctx.manualForm ? "send_from_another_wallet" : "pay_with";
    case "confirming":
    case "verifying":
      return "verifying";
    case "verify_failed":
      return "verify_failed";
    case "pay_wallet":
      if (!s.verified) return "verifying";
      if (s.session && !s.session.livemode) return "test_payment";
      if (s.error?.code === INSUFFICIENT_FUNDS) return "not_enough_funds";
      if (s.error?.code === "wallet_rejected") return "not_approved";
      if (s.error?.code === TX_FAILED) return "tx_failed";
      if (ctx.busy) return "approve_in_wallet";
      return ctx.totalChanged ? "review_updated" : "review";
    case "pay_manual":
      return s.verified ? "send_manual" : "verifying";
    case "needs_top_up":
      return s.verified ? "received_less" : "verifying";
    case "expired_address":
      return s.path === "wallet" ? "quote_expired" : "address_expired";
    case "processing":
      if (s.attempt && WAITING.has(s.attempt.status)) return "waiting";
      return ctx.slow ? "still_confirming" : "confirming";
    case "review":
      return "under_review";
    case "succeeded":
      return "complete";
    case "refunded":
      if (s.attempt?.status === "refunded") return "returned";
      if (s.attempt?.status === "expired_unpaid") return "quote_expired";
      return s.depositSeen ? "being_returned" : "not_completed";
  }
}

/** Every §4 phase and the screens it can render (documentation + exhaustiveness test). */
export const PHASE_SCREENS: Readonly<Record<State["phase"], readonly ScreenId[]>> = {
  loading: ["loading"],
  blocked: ["blocked"],
  choose_path: ["start"],
  connect_wallet: ["connect_wallet"],
  choose_asset: ["pay_with", "no_options", "send_from_another_wallet"],
  confirming: ["verifying"],
  verifying: ["verifying"],
  verify_failed: ["verify_failed"],
  pay_wallet: [
    "review",
    "review_updated",
    "test_payment",
    "approve_in_wallet",
    "not_approved",
    "not_enough_funds",
    "tx_failed",
  ],
  pay_manual: ["send_manual"],
  needs_top_up: ["received_less"],
  expired_address: ["quote_expired", "address_expired"],
  processing: ["waiting", "confirming", "still_confirming"],
  review: ["under_review"],
  succeeded: ["complete"],
  refunded: ["returned", "being_returned", "quote_expired", "not_completed"],
};

/** Phases whose "Back" goes one step back inside the flow. */
export function canGoBack(s: State): boolean {
  return s.phase === "connect_wallet" || s.phase === "choose_asset";
}

/**
 * Destination chains whose evidence usually lands within a minute: L2 block confirmations on Base and Arbitrum
 * (ADR-0022), NEAR finality, Solana `finalized`. Others (Ethereum `finalized`, Bitcoin confirmations) take longer.
 */
export const FAST_CONFIRMING_CHAINS: ReadonlySet<string> = new Set([
  "eip155:8453",
  "eip155:42161",
  "near:mainnet",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
]);

/**
 * Body of the "Confirming your payment" frame. While the attempt is `verifying` (the funds reached the merchant's
 * chain and NearPay is confirming them) it names the attested destination chain: "Payment received — confirming on
 * Base (usually under a minute)."; otherwise (deposit seen, swap settling) the generic text.
 */
export function confirmingBody(
  attemptStatus: string | null | undefined,
  destinationChain: string | null | undefined,
): { readonly key: "confirming.body" | "confirming.bodyChain" | "confirming.bodyChainFast"; readonly chain?: string } {
  if (attemptStatus !== "verifying" || !destinationChain) return { key: "confirming.body" };
  const chain = chainName(destinationChain);
  return FAST_CONFIRMING_CHAINS.has(destinationChain)
    ? { key: "confirming.bodyChainFast", chain }
    : { key: "confirming.bodyChain", chain };
}

/** `HH:MM:SS` (24 h, local time) of a "Check status" press, for "Still confirming · checked 14:03:07". */
export function checkedAtLabel(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
