/** Shared unit-test fixtures built from the spec's test vectors. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ed25519 } from "@noble/curves/ed25519.js";
import canonicalize from "canonicalize";

const require = createRequire(import.meta.url);
export function vector<T>(name: string): T {
  return JSON.parse(readFileSync(require.resolve(`@nearpay-money/spec/test-vectors/${name}`), "utf8")) as T;
}

export interface SignedVector {
  attestation: Record<string, unknown> & { deposit?: Record<string, unknown>; requirement?: Record<string, unknown> };
  kid: string;
  signature: string;
}

export const sentinelVectors = vector<{
  key: { kid: string; seed_hex: string; public_key_base64url: string };
  valid: { canonical_json: string; signed: SignedVector }[];
  invalid: { reason: string; signed: SignedVector }[];
}>("sentinel-attestation.json");

export const PINNED = [{ kid: sentinelVectors.key.kid, public_key: sentinelVectors.key.public_key_base64url }];
export const SEED = Uint8Array.from(Buffer.from(sentinelVectors.key.seed_hex, "hex"));

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/** Signs an attestation with the test-vector sentinel key (or another seed). */
export function signAttestation(
  attestation: object,
  seed: Uint8Array = SEED,
  kid = sentinelVectors.key.kid,
): SignedVector {
  const msg = new TextEncoder().encode(canonicalize(attestation) as string);
  return { attestation: attestation as SignedVector["attestation"], kid, signature: b64url(ed25519.sign(msg, seed)) };
}

export const VECTOR_TIME = Date.parse("2026-11-05T10:05:00.000Z");

/** A PayerAttempt matching a vector attestation. */
export function attemptFor(signed: SignedVector) {
  const a = signed.attestation as Record<string, unknown> & {
    deposit?: Record<string, string | null>;
    requirement?: Record<string, string>;
  };
  const route = a.kind === "route_quote";
  return {
    id: a.attempt_id as `pa_${string}`,
    object: "payment_attempt" as const,
    livemode: a.livemode as boolean,
    status: "awaiting_deposit" as const,
    method: a.kind as "route_quote" | "intents_transfer",
    visible: true,
    origin_asset_id: route ? (a.deposit?.origin_asset_id as string) : (a.requirement?.token as string),
    deposit: route ? ({ ...a.deposit, min_amount_in: "2000000" } as never) : null,
    intents_requirement: route ? null : ({ ...a.requirement } as never),
    attestation_ticket: "eyJ.sig",
    failure_code: null,
    refunded_amount: null,
  };
}
