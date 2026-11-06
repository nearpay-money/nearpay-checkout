/** Spec-valid payer objects for unit and e2e tests. */
import type { IntentStreamEvent, PayerAttempt, PublicCheckoutSession } from "@nearpay/spec";
import type { z } from "zod";

export type Session = z.output<typeof PublicCheckoutSession>;
export type Attempt = z.output<typeof PayerAttempt>;
export type Intent = z.output<typeof IntentStreamEvent>;

export const SESSION_ID = "cs_01jbz9k3m4n5p6q7r8s9t0v1w2";
export const SECRET = `${SESSION_ID}_secret_${"Ab1".repeat(10)}Xy`;
export const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
export const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

export function session(over: Partial<Session> = {}): Session {
  return {
    id: SESSION_ID,
    object: "checkout_session",
    livemode: false,
    status: "open",
    intent_status: "requires_payment",
    amount: 200,
    currency: "usd",
    asset_id: null,
    display: { merchant_name_unverified: "Acme (unverified)", description: "Pro plan" },
    expires_at: "2026-11-05T11:00:00.000Z",
    settlement: { asset_id: USDC_NEAR, chain: "near:mainnet", type: "intents_account" },
    ui_mode: "hosted",
    allowed_origins: [],
    success_url: "https://shop.example/thanks",
    cancel_url: "https://shop.example/cart",
    attempt: null,
    ...over,
  };
}

export function attempt(over: Partial<Attempt> = {}): Attempt {
  return {
    id: "pa_01jbz9k3m4n5p6q7r8s9t0v1w2",
    object: "payment_attempt",
    livemode: false,
    status: "awaiting_deposit",
    method: "route_quote",
    visible: true,
    origin_asset_id: USDC_BASE,
    deposit: {
      address: "0x76b4c56085ed136a8744d52be956396624a730e8",
      memo: null,
      amount_in: "2005013",
      min_amount_in: "2000000",
      deadline: "2026-11-05T10:15:00.000Z",
      chain: "eip155:8453",
      origin_asset_id: USDC_BASE,
    },
    intents_requirement: null,
    attestation_ticket: "eyJhIjoxfQ.c2ln",
    failure_code: null,
    refunded_amount: null,
    ...over,
  };
}
