/**
 * Refund-address validation per chain (lld/checkout-and-js.md §5.5). Mirrors the kit's chain address
 * rules (lld/00-foundations.md §6) so the payer learns about a typo before an attempt is created;
 * payments/rails validate again server-side.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import bs58 from "bs58";
import { getChain } from "../../lib/chains/chains";

export type AddressCheck = { ok: true; normalized: string } | { ok: false; reason: AddressProblem };
export type AddressProblem =
  | "empty"
  | "unsupported_chain"
  | "evm_format"
  | "evm_checksum"
  | "zero_address"
  | "near_format"
  | "solana_format"
  | "bitcoin_format"
  | "bitcoin_checksum";

const NEAR_ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function toChecksumAddress(address: string): string {
  const lower = address.slice(2).toLowerCase();
  const hash = keccak_256(new TextEncoder().encode(lower));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    const nibble = ((hash[i >> 1] as number) >> (i % 2 === 0 ? 4 : 0)) & 0xf;
    out += nibble >= 8 ? (lower[i] as string).toUpperCase() : lower[i];
  }
  return out;
}

function checkEvm(a: string): AddressCheck {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return { ok: false, reason: "evm_format" };
  const body = a.slice(2);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && toChecksumAddress(a) !== a) return { ok: false, reason: "evm_checksum" };
  if (/^0x0{40}$/i.test(a)) return { ok: false, reason: "zero_address" };
  return { ok: true, normalized: a.toLowerCase() };
}

function checkNear(a: string): AddressCheck {
  if (!NEAR_ACCOUNT_RE.test(a)) return { ok: false, reason: "near_format" };
  if (a.startsWith("0x") && !/^0x[0-9a-f]{40}$/.test(a)) return { ok: false, reason: "near_format" };
  return { ok: true, normalized: a };
}

function checkSolana(a: string): AddressCheck {
  try {
    if (bs58.decode(a).length !== 32) return { ok: false, reason: "solana_format" };
  } catch {
    return { ok: false, reason: "solana_format" };
  }
  return { ok: true, normalized: a };
}

const B32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(values: number[]): number {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= G[i] as number;
  }
  return chk >>> 0;
}
function hrpExpand(hrp: string): number[] {
  return [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
}
function convertBits(data: number[], from: number, to: number): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) return null;
  return out;
}
function checkSegwit(a: string, hrp: string): AddressCheck {
  if (a !== a.toLowerCase() && a !== a.toUpperCase()) return { ok: false, reason: "bitcoin_format" };
  const s = a.toLowerCase();
  const pos = s.lastIndexOf("1");
  if (s.slice(0, pos) !== hrp || pos < 1 || s.length - pos - 1 < 6 || s.length > 90)
    return { ok: false, reason: "bitcoin_format" };
  const data = [...s.slice(pos + 1)].map((c) => B32.indexOf(c));
  if (data.some((d) => d < 0)) return { ok: false, reason: "bitcoin_format" };
  const witver = data[0] as number;
  const constant = polymod([...hrpExpand(hrp), ...data]);
  if (constant !== (witver === 0 ? 1 : 0x2bc830a3)) return { ok: false, reason: "bitcoin_checksum" };
  const prog = convertBits(data.slice(1, -6), 5, 8);
  if (!prog || prog.length < 2 || prog.length > 40 || witver > 16) return { ok: false, reason: "bitcoin_format" };
  if (witver === 0 && prog.length !== 20 && prog.length !== 32) return { ok: false, reason: "bitcoin_format" };
  return { ok: true, normalized: s };
}
function checkBase58Check(a: string, versions: number[]): AddressCheck {
  let raw: Uint8Array;
  try {
    raw = bs58.decode(a);
  } catch {
    return { ok: false, reason: "bitcoin_format" };
  }
  if (raw.length !== 25) return { ok: false, reason: "bitcoin_format" };
  const check = sha256(sha256(raw.slice(0, 21))).slice(0, 4);
  if (!check.every((b, i) => b === raw[21 + i])) return { ok: false, reason: "bitcoin_checksum" };
  if (!versions.includes(raw[0] as number)) return { ok: false, reason: "bitcoin_format" };
  return { ok: true, normalized: a };
}

/** Validates a refund address for the origin chain; `normalized` is lower-case for EVM. */
export function validateRefundAddress(chain: string, input: string): AddressCheck {
  const a = input.trim();
  if (a.length === 0) return { ok: false, reason: "empty" };
  const c = getChain(chain);
  if (!c) return { ok: false, reason: "unsupported_chain" };
  switch (c.family) {
    case "evm":
      return checkEvm(a);
    case "near":
      return checkNear(a);
    case "solana":
      return checkSolana(a);
    case "bitcoin": {
      const p = c.btc as NonNullable<typeof c.btc>;
      if (p.hrp && a.toLowerCase().startsWith(`${p.hrp}1`)) return checkSegwit(a, p.hrp);
      return checkBase58Check(a, [p.p2pkh, p.p2sh]);
    }
  }
}
