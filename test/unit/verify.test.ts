import { describe, expect, it } from "vitest";
import { base64UrlDecode, canonicalBytes, verifyAttestation } from "../../src/lib/integrity/verify";
import { attemptFor, PINNED, sentinelVectors, signAttestation, VECTOR_TIME } from "../support/fixtures";

const [routeVec, intentsVec] = sentinelVectors.valid as [
  (typeof sentinelVectors.valid)[0],
  (typeof sentinelVectors.valid)[0],
];
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const EARLY = Date.parse("2026-11-05T10:00:30.000Z");

describe("sentinel verification (shared vectors)", () => {
  it("canonical JSON equals the vector bytes", () => {
    for (const v of sentinelVectors.valid) {
      expect(new TextDecoder().decode(canonicalBytes(v.signed.attestation) as Uint8Array)).toBe(v.canonical_json);
    }
  });

  it("accepts both valid vectors for their own attempt", () => {
    const r = verifyAttestation(routeVec.signed, PINNED, attemptFor(routeVec.signed), VECTOR_TIME);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.verified.attestation.merchant.name).toBe("Acme GmbH");
      expect(r.verified.attestation.destination.fingerprint).toBe("YZMN-R81Z-BR");
      expect(r.verified.validUntil).toBe(Date.parse("2026-11-05T10:15:00.000Z"));
    }
    const i = verifyAttestation(intentsVec.signed, PINNED, attemptFor(intentsVec.signed), EARLY);
    expect(i.ok).toBe(true);
  });

  it("rejects every invalid vector", () => {
    for (const v of sentinelVectors.invalid) {
      const attempt = attemptFor(routeVec.signed);
      const r = verifyAttestation(v.signed, PINNED, attempt, VECTOR_TIME);
      expect(r.ok, v.reason).toBe(false);
    }
  });

  it("names the failure", () => {
    const attempt = attemptFor(routeVec.signed);
    const unknown = sentinelVectors.invalid.find((v) => v.reason === "unknown kid")?.signed;
    expect(verifyAttestation(unknown, PINNED, attempt, VECTOR_TIME)).toEqual({ ok: false, reason: "unknown_kid" });
    const tampered = sentinelVectors.invalid.find((v) => v.reason.startsWith("deposit address"))?.signed;
    expect(verifyAttestation(tampered, PINNED, attempt, VECTOR_TIME)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyAttestation({ nope: 1 }, PINNED, attempt, VECTOR_TIME)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyAttestation(null, PINNED, attempt, VECTOR_TIME)).toEqual({ ok: false, reason: "malformed" });
  });

  it("fails without any pinned key", () => {
    expect(verifyAttestation(routeVec.signed, [], attemptFor(routeVec.signed), VECTOR_TIME).ok).toBe(false);
  });

  it("rejects a valid signature from a key that is not pinned under that kid", () => {
    const rogue = signAttestation(routeVec.signed.attestation, new Uint8Array(32).fill(7));
    expect(verifyAttestation(rogue, PINNED, attemptFor(routeVec.signed), VECTOR_TIME)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a corrupt pinned key or signature encoding", () => {
    const bad = [{ kid: PINNED[0]?.kid as string, public_key: "AAAA" }];
    expect(verifyAttestation(routeVec.signed, bad, attemptFor(routeVec.signed), VECTOR_TIME).ok).toBe(false);
    const s = clone(routeVec.signed);
    s.signature = "AAAA";
    expect(verifyAttestation(s, PINNED, attemptFor(routeVec.signed), VECTOR_TIME).ok).toBe(false);
  });

  it("covers unknown fields with the signature", () => {
    const att = { ...clone(routeVec.signed.attestation), extra: "covered" };
    const signed = signAttestation(att);
    expect(verifyAttestation(signed, PINNED, attemptFor(routeVec.signed), VECTOR_TIME).ok).toBe(true);
    const stripped = clone(signed);
    delete (stripped.attestation as Record<string, unknown>).extra;
    expect(verifyAttestation(stripped, PINNED, attemptFor(routeVec.signed), VECTOR_TIME).ok).toBe(false);
  });

  it("any single-field mutation of a signed attestation fails (sentinel §13 property)", () => {
    const base = routeVec.signed;
    const attempt = attemptFor(base);
    const paths: [string, string | null][] = [
      ["deposit.address", "0x0000000000000000000000000000000000000bad"],
      ["deposit.memo", "x"],
      ["deposit.chain", "eip155:1"],
      ["deposit.amount_in", "1"],
      ["deposit.deadline", "2026-11-05T10:16:00.000Z"],
      ["merchant.name", "Evil Ltd"],
      ["destination.fingerprint", "AAAA-AAAA-AA"],
      ["issued_at", "2026-11-05T10:00:02.000Z"],
    ];
    for (const [path, value] of paths) {
      const s = clone(base);
      const [a, b] = path.split(".") as [string, string | undefined];
      const att = s.attestation as Record<string, Record<string, unknown> | unknown>;
      if (b) (att[a] as Record<string, unknown>)[b] = value;
      else att[a] = value;
      expect(verifyAttestation(s, PINNED, attempt, VECTOR_TIME).ok, path).toBe(false);
    }
  });
});

describe("field equality with the attempt (§5.2)", () => {
  const signed = routeVec.signed;
  const cases: [string, (a: ReturnType<typeof attemptFor>) => void][] = [
    [
      "address",
      (a) => ((a.deposit as unknown as Record<string, unknown>).address = "0x1111111111111111111111111111111111111111"),
    ],
    ["memo", (a) => ((a.deposit as unknown as Record<string, unknown>).memo = "123")],
    ["chain", (a) => ((a.deposit as unknown as Record<string, unknown>).chain = "eip155:1")],
    [
      "origin_asset_id",
      (a) => ((a.deposit as unknown as Record<string, unknown>).origin_asset_id = "nep141:wrap.near"),
    ],
    ["origin_asset_id", (a) => (a.origin_asset_id = "nep141:wrap.near")],
    ["amount_in", (a) => ((a.deposit as unknown as Record<string, unknown>).amount_in = "2005014")],
    ["deadline", (a) => ((a.deposit as unknown as Record<string, unknown>).deadline = "2026-11-05T10:20:00.000Z")],
  ];
  for (const [field, mutate] of cases) {
    it(`detects a different ${field}`, () => {
      const a = attemptFor(signed);
      mutate(a);
      expect(verifyAttestation(signed, PINNED, a, VECTOR_TIME)).toEqual({ ok: false, reason: "field_mismatch", field });
    });
  }

  it("compares deadlines as instants", () => {
    const a = attemptFor(signed);
    (a.deposit as unknown as Record<string, unknown>).deadline = "2026-11-05T10:15:00Z";
    expect(verifyAttestation(signed, PINNED, a, VECTOR_TIME).ok).toBe(true);
  });

  it("binds the attestation to the attempt id, mode and kind", () => {
    expect(
      verifyAttestation(signed, PINNED, { ...attemptFor(signed), id: "pa_01jbz9k3m4n5p6q7r8s9t0v1w9" }, VECTOR_TIME),
    ).toEqual({ ok: false, reason: "wrong_attempt" });
    expect(verifyAttestation(signed, PINNED, { ...attemptFor(signed), livemode: false }, VECTOR_TIME)).toEqual({
      ok: false,
      reason: "wrong_mode",
    });
    expect(
      verifyAttestation(signed, PINNED, { ...attemptFor(signed), method: "intents_transfer" }, VECTOR_TIME),
    ).toEqual({ ok: false, reason: "wrong_kind" });
  });

  it("needs instructions on both sides", () => {
    expect(verifyAttestation(signed, PINNED, { ...attemptFor(signed), deposit: null }, VECTOR_TIME)).toEqual({
      ok: false,
      reason: "no_instructions",
    });
    const i = intentsVec.signed;
    expect(verifyAttestation(i, PINNED, { ...attemptFor(i), intents_requirement: null }, EARLY)).toEqual({
      ok: false,
      reason: "no_instructions",
    });
  });

  it("checks every requirement field", () => {
    const i = intentsVec.signed;
    for (const f of ["pay_to", "token", "amount", "fee_to", "fee_amount", "binding", "deadline"]) {
      const a = attemptFor(i);
      (a.intents_requirement as unknown as Record<string, string>)[f] =
        f === "deadline"
          ? "2026-11-05T10:03:00.000Z"
          : f === "binding"
            ? "np1:AQDxa2L6a5d8egVC7YP85UgtUCYp3cUotS6S3EsGcF7i"
            : "other.near";
      expect(verifyAttestation(i, PINNED, a, EARLY)).toEqual({ ok: false, reason: "field_mismatch", field: f });
    }
  });

  it("refuses expired attestations and expiry after the deadline", () => {
    expect(verifyAttestation(signed, PINNED, attemptFor(signed), Date.parse("2026-11-05T10:15:00.000Z"))).toEqual({
      ok: false,
      reason: "expired",
    });
    const att = clone(signed.attestation);
    att.expires_at = "2026-11-05T10:20:00.000Z";
    expect(verifyAttestation(signAttestation(att), PINNED, attemptFor(signed), VECTOR_TIME)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("uses the earlier of deadline and expiry", () => {
    const att = clone(signed.attestation);
    att.expires_at = "2026-11-05T10:10:00.000Z";
    const r = verifyAttestation(signAttestation(att), PINNED, attemptFor(signed), VECTOR_TIME);
    expect(r.ok && r.verified.validUntil).toBe(Date.parse("2026-11-05T10:10:00.000Z"));
  });

  it("refuses an attestation carrying both deposit and requirement", () => {
    const att = { ...clone(signed.attestation), requirement: clone(intentsVec.signed.attestation.requirement) };
    expect(verifyAttestation(signAttestation(att), PINNED, attemptFor(signed), VECTOR_TIME)).toEqual({
      ok: false,
      reason: "no_instructions",
    });
  });
});

describe("base64url", () => {
  it("decodes and rejects junk", () => {
    expect(Array.from(base64UrlDecode("AQID") as Uint8Array)).toEqual([1, 2, 3]);
    expect(base64UrlDecode("A")).toBeNull();
    expect(base64UrlDecode("a+b")).toBeNull();
  });
  it("canonicalBytes refuses non-JSON values", () => {
    expect(canonicalBytes(undefined)).toBeNull();
  });
});
