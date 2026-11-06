/**
 * Intents-balance path (lld/checkout-and-js.md §5.4, foundations §14): the Verifier message built from
 * the ATTESTED requirement — two `transfer` intents (merchant, then NearPay fee), both with memo =
 * binding — signed by the payer's wallet: NEP-413 for NEAR wallets, ERC-191 `personal_sign` for EVM
 * wallets (eth-implicit Intents account = lower-case 0x address).
 */
import { INTENTS_CONTRACT, type IntentMessage, type IntentsRequirement, type MultiPayload } from "@nearpay/spec";
import bs58 from "bs58";

/** Salt the test-mode (sandbox) Verifier uses; never a mainnet salt, so test payloads cannot execute on mainnet. */
export const SANDBOX_SALT = "5a0dbe11";

const toBase64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
const fromBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function makeNonce(
  saltHex: string,
  random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): Uint8Array {
  if (!/^[0-9a-f]{8}$/.test(saltHex)) throw new RangeError("salt must be 4 bytes of lower-case hex");
  const nonce = new Uint8Array(32);
  for (let i = 0; i < 4; i++) nonce[i] = Number.parseInt(saltHex.slice(i * 2, i * 2 + 2), 16);
  const r = random(28);
  if (r.length !== 28) throw new RangeError("random source must return 28 bytes");
  nonce.set(r, 4);
  return nonce;
}

export function transferIntents(req: IntentsRequirement): IntentMessage["intents"] {
  if (BigInt(req.amount) <= 0n) throw new RangeError("amount must be positive");
  return [
    { intent: "transfer", receiver_id: req.pay_to, tokens: { [req.token]: req.amount }, memo: req.binding },
    { intent: "transfer", receiver_id: req.fee_to, tokens: { [req.token]: req.fee_amount }, memo: req.binding },
  ];
}

export function intentMessage(req: IntentsRequirement, signerId: string, nonce: Uint8Array): IntentMessage {
  return {
    signer_id: signerId,
    verifying_contract: INTENTS_CONTRACT,
    deadline: req.deadline,
    nonce: toBase64(nonce),
    intents: transferIntents(req),
  };
}

/** NEP-413 `message` field: the message without nonce and verifying_contract. */
export function nep413Message(m: IntentMessage): string {
  return JSON.stringify({ signer_id: m.signer_id, deadline: m.deadline, intents: m.intents });
}

/** NEAR wallet `signMessage` output → MultiPayload (`signature` from wallets is base64 or `ed25519:<b58>`). */
export function nep413Payload(
  m: IntentMessage,
  signed: { readonly publicKey: string; readonly signature: string },
): MultiPayload {
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(signed.publicKey))
    throw new Error("The wallet returned an unexpected key.");
  let sig: Uint8Array;
  if (signed.signature.startsWith("ed25519:")) sig = bs58.decode(signed.signature.slice(8));
  else sig = fromBase64(signed.signature);
  if (sig.length !== 64) throw new Error("The wallet returned an unexpected signature.");
  return {
    standard: "nep413",
    payload: { recipient: INTENTS_CONTRACT, nonce: m.nonce, message: nep413Message(m) },
    public_key: signed.publicKey,
    signature: `ed25519:${bs58.encode(sig)}`,
  };
}

/** `personal_sign` hex (r ‖ s ‖ v, v ∈ {0,1,27,28}) → MultiPayload with v normalised to 0/1, base58. */
export function erc191Payload(m: IntentMessage, sigHex: string): MultiPayload {
  if (!/^0x[0-9a-fA-F]{130}$/.test(sigHex)) throw new Error("The wallet returned an unexpected signature.");
  const bytes = Uint8Array.from(sigHex.slice(2).match(/../g) ?? [], (h) => Number.parseInt(h, 16));
  const v = bytes[64] as number;
  if (v === 27 || v === 28) bytes[64] = v - 27;
  else if (v !== 0 && v !== 1) throw new Error("The wallet returned an unexpected signature.");
  return { standard: "erc191", payload: JSON.stringify(m), signature: `secp256k1:${bs58.encode(bytes)}` };
}
