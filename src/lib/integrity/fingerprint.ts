/**
 * Destination fingerprint (lld/sentinel.md §5): first 10 symbols of upper-case Crockford base32 of
 * sha256(`chain|address_norm|asset_id`), grouped 4-4-2. Checkout never knows the destination address
 * (the payer API hides it) and therefore only DISPLAYS the attested fingerprint; `computeFingerprint`
 * exists so tests can check the shared vector and the merchant-facing format stays identical.
 */
import { sha256 } from "@noble/hashes/sha2.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const FINGERPRINT_RE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{2}$/;

export function computeFingerprint(chain: string, addressNorm: string, assetId: string): string {
  const digest = sha256(new TextEncoder().encode(`${chain}|${addressNorm}|${assetId}`));
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const byte of digest) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 10) {
      bits -= 5;
      out += CROCKFORD[(acc >> bits) & 31];
    }
    if (out.length >= 10) break;
    acc &= (1 << bits) - 1;
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 10)}`;
}

/** Splits a fingerprint into groups for display (screen readers get them spelled out). */
export function fingerprintGroups(fp: string): string[] {
  return FINGERPRINT_RE.test(fp) ? fp.split("-") : [];
}
