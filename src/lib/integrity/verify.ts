/**
 * Sentinel verification — the two-party release of FR-PAY-10 (ADR-0010, lld/checkout-and-js.md §5.2).
 *
 * Deposit instructions (or an Intents-transfer requirement) are rendered only when ALL of this holds:
 *  1. the response is a well-formed `SignedAttestation` and `kid` is one of the build-pinned keys;
 *  2. the Ed25519 signature verifies over the RFC 8785 (JCS) canonical JSON of `attestation` exactly as
 *     received (unknown fields included — they are covered by the signature);
 *  3. the attestation is about this attempt (`attempt_id`, `livemode`, `kind`);
 *  4. every field checkout would display equals the attested field (address, memo, chain, origin asset,
 *     amount_in, deadline — or pay_to, token, amount, fee_to, fee_amount, binding, deadline);
 *  5. it has not expired, and `expires_at` is not after the deadline.
 * The UI then renders the ATTESTED values (merchant name, KYB badge, destination fingerprint and the
 * instructions themselves), never the payments copy. Any failure → no address, no wallet prompt.
 */

import type { Attestation, PayerAttempt } from "@nearpay/spec";
import { SignedAttestation } from "@nearpay/spec";
import { ed25519 } from "@noble/curves/ed25519.js";
import canonicalize from "canonicalize";
import type { z } from "zod";

type Attempt = z.output<typeof PayerAttempt>;

export interface PinnedKey {
  readonly kid: string;
  readonly public_key: string;
}

export type VerifyFailure =
  | "malformed"
  | "unknown_kid"
  | "bad_signature"
  | "wrong_attempt"
  | "wrong_mode"
  | "wrong_kind"
  | "field_mismatch"
  | "no_instructions"
  | "expired";

export interface VerifiedInstructions {
  readonly attestation: Attestation;
  readonly kid: string;
  /** Instructions stop being shown at this instant (min of deadline and attestation expiry). */
  readonly validUntil: number;
}

export type VerifyResult =
  | { readonly ok: true; readonly verified: VerifiedInstructions }
  | { readonly ok: false; readonly reason: VerifyFailure; readonly field?: string };

const enc = new TextEncoder();

export function base64UrlDecode(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const b64 = s
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(s.length / 4) * 4, "=");
  try {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Canonical bytes that sentinel signs: UTF-8 of RFC 8785 JSON of the attestation object. */
export function canonicalBytes(attestation: unknown): Uint8Array | null {
  const json = canonicalize(attestation);
  return typeof json === "string" ? enc.encode(json) : null;
}

const instant = (s: string): number => Date.parse(s);
const sameInstant = (a: string, b: string): boolean => {
  const x = instant(a);
  return Number.isFinite(x) && x === instant(b);
};

function fail(reason: VerifyFailure, field?: string): VerifyResult {
  return field ? { ok: false, reason, field } : { ok: false, reason };
}

/**
 * Verifies a sentinel response (`raw` = parsed JSON body, untouched) for `attempt`.
 * `now` is epoch milliseconds.
 */
export function verifyAttestation(
  raw: unknown,
  pinned: readonly PinnedKey[],
  attempt: Attempt,
  now: number,
): VerifyResult {
  const parsed = SignedAttestation.safeParse(raw);
  if (!parsed.success) return fail("malformed");
  const signed = parsed.data;
  const key = pinned.find((k) => k.kid === signed.kid);
  if (!key) return fail("unknown_kid");
  const pub = base64UrlDecode(key.public_key);
  const sig = base64UrlDecode(signed.signature);
  const msg = canonicalBytes((raw as { attestation: unknown }).attestation);
  if (pub?.length !== 32 || !sig || sig.length !== 64 || !msg) return fail("bad_signature");
  let valid = false;
  try {
    valid = ed25519.verify(sig, msg, pub, { zip215: false });
  } catch {
    valid = false;
  }
  if (!valid) return fail("bad_signature");

  const a = signed.attestation;
  if (a.attempt_id !== attempt.id) return fail("wrong_attempt");
  if (a.livemode !== attempt.livemode) return fail("wrong_mode");
  if (a.kind !== attempt.method) return fail("wrong_kind");

  let deadline: string;
  if (a.kind === "route_quote") {
    const shown = attempt.deposit;
    const att = a.deposit;
    if (!shown || !att || a.requirement) return fail("no_instructions");
    if (att.address !== shown.address) return fail("field_mismatch", "address");
    if (att.memo !== shown.memo) return fail("field_mismatch", "memo");
    if (att.chain !== shown.chain) return fail("field_mismatch", "chain");
    if (att.origin_asset_id !== shown.origin_asset_id || att.origin_asset_id !== attempt.origin_asset_id)
      return fail("field_mismatch", "origin_asset_id");
    if (att.amount_in !== shown.amount_in) return fail("field_mismatch", "amount_in");
    if (!sameInstant(att.deadline, shown.deadline)) return fail("field_mismatch", "deadline");
    deadline = att.deadline;
  } else {
    const shown = attempt.intents_requirement;
    const att = a.requirement;
    if (!shown || !att || a.deposit) return fail("no_instructions");
    for (const f of ["pay_to", "token", "amount", "fee_to", "fee_amount", "binding"] as const) {
      if (att[f] !== shown[f]) return fail("field_mismatch", f);
    }
    if (!sameInstant(att.deadline, shown.deadline)) return fail("field_mismatch", "deadline");
    deadline = att.deadline;
  }

  const expiresAt = instant(a.expires_at);
  const deadlineAt = instant(deadline);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(deadlineAt) || expiresAt > deadlineAt) return fail("malformed");
  if (expiresAt <= now) return fail("expired");
  return { ok: true, verified: { attestation: a, kid: signed.kid, validUntil: Math.min(expiresAt, deadlineAt) } };
}
