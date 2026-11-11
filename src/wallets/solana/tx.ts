/**
 * Solana deposits built inside the checkout (lld/checkout-and-js.md §11, spec 0.4.0
 * `test-vectors/solana-transfer.json`): from the VERIFIED attestation only.
 *
 * - SOL (`nep141:sol.omft.near`, token `native`): `System.Transfer(payer → deposit, amount_in lamports)`.
 * - SPL (token `spl`, a mint that reproduces the omft asset id, owned by the classic Token program —
 *   the owner is checked over RPC by the caller): `AssociatedTokenAccount.CreateIdempotent` for the
 *   deposit's ATA, then `Token.TransferChecked(payer ATA → deposit ATA, amount_in, decimals)`.
 * - No memo and no Solana Pay `reference`: the wallet path exists only when `deposit.memo` is null.
 *
 * The message is a legacy message (no lookup tables) with the connected wallet as fee payer, serialised
 * here without a Solana SDK; the wallet signs and sends it (`solana:signAndSendTransaction`).
 */
import type { Attestation } from "@nearpay-money/spec";
import { parseOmftAssetId, SOLANA_MAINNET } from "@nearpay-money/spec";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import bs58 from "bs58";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SOL_ASSET_ID = "nep141:sol.omft.near";
const U64_MAX = (1n << 64n) - 1n;

export interface AccountMeta {
  readonly pubkey: string;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
}

export interface Instruction {
  readonly programId: string;
  readonly accounts: readonly AccountMeta[];
  readonly data: Uint8Array;
}

/** Decodes a base58 public key; throws unless it is exactly 32 bytes. */
export function pubkeyBytes(a: string): Uint8Array {
  let raw: Uint8Array;
  try {
    raw = bs58.decode(a);
  } catch {
    throw new RangeError("not a Solana address");
  }
  if (raw.length !== 32) throw new RangeError("not a Solana address");
  return raw;
}

export function isSolanaAddress(a: string): boolean {
  try {
    pubkeyBytes(a);
    return true;
  } catch {
    return false;
  }
}

function isOnCurve(b: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(b, true);
    return true;
  } catch {
    return false;
  }
}

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

/** `findProgramAddress(seeds, program)`: the highest bump whose hash is off the ed25519 curve. */
export function findProgramAddress(seeds: readonly Uint8Array[], programId: string): { address: string; bump: number } {
  const program = pubkeyBytes(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), program, PDA_MARKER];
    const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      buf.set(p, o);
      o += p.length;
    }
    const h = sha256(buf);
    if (!isOnCurve(h)) return { address: bs58.encode(h), bump };
  }
  throw new Error("no program address");
}

/** Associated token account of `owner` for `mint` (classic Token program). */
export function associatedTokenAddress(owner: string, mint: string): { address: string; bump: number } {
  return findProgramAddress(
    [pubkeyBytes(owner), pubkeyBytes(TOKEN_PROGRAM), pubkeyBytes(mint)],
    ASSOCIATED_TOKEN_PROGRAM,
  );
}

/** hex(keccak256(mint bytes)[12..32]): the `<token>` of the SPL omft asset id. */
export function splAssetToken(mint: string): string {
  const h = keccak_256(pubkeyBytes(mint)).slice(12);
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** `nep141:sol-<hash20>.omft.near` for a mint (spec 0.4.0 SPL asset id rule). */
export function splAssetId(mint: string): string {
  return `nep141:sol-${splAssetToken(mint)}.omft.near`;
}

function u64le(v: bigint): Uint8Array {
  if (v < 0n || v > U64_MAX) throw new RangeError("amount out of u64 range");
  const out = new Uint8Array(8);
  let x = v;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function amount(a: string): bigint {
  if (!/^[1-9][0-9]{0,19}$/.test(a)) throw new RangeError("bad amount");
  const v = BigInt(a);
  if (v > U64_MAX) throw new RangeError("amount out of u64 range");
  return v;
}

export function systemTransfer(from: string, to: string, lamports: string): Instruction {
  const data = new Uint8Array(12);
  data.set([2, 0, 0, 0], 0);
  data.set(u64le(amount(lamports)), 4);
  return {
    programId: SYSTEM_PROGRAM,
    accounts: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
    ],
    data,
  };
}

export function createAtaIdempotent(payer: string, ata: string, owner: string, mint: string): Instruction {
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM,
    accounts: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Uint8Array.of(1),
  };
}

export function transferChecked(
  source: string,
  mint: string,
  destination: string,
  owner: string,
  amountBase: string,
  decimals: number,
): Instruction {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new RangeError("bad decimals");
  const data = new Uint8Array(10);
  data[0] = 12;
  data.set(u64le(amount(amountBase)), 1);
  data[9] = decimals;
  return {
    programId: TOKEN_PROGRAM,
    accounts: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  };
}

// ---- recipe from the verified attestation -----------------------------------------------------------

export type SolanaRecipe =
  | { readonly kind: "sol"; readonly deposit: string; readonly lamports: string }
  | {
      readonly kind: "spl";
      readonly deposit: string;
      readonly mint: string;
      readonly decimals: number;
      readonly amount: string;
    };

/** Why the wallet path is not offered (the manual path still is). */
export type SolanaManualReason = "memo" | "no_asset" | "token" | "mint_mismatch" | "token_2022" | "mint_unknown";

export type SolanaRecipeResult =
  | { readonly ok: true; readonly recipe: SolanaRecipe }
  | { readonly ok: false; readonly reason: SolanaManualReason };

/**
 * The wallet recipe of a verified Solana route quote (§11). Fail closed: anything but SOL with a
 * `native` token or an SPL mint that reproduces the attested asset id → manual path. The SPL mint's
 * owner (classic Token program vs Token-2022) is checked separately over RPC (`checkMintOwner`).
 * Returns null when the attestation is not a Solana route quote at all.
 */
export function solanaRecipe(att: Pick<Attestation, "kind" | "deposit" | "asset">): SolanaRecipeResult | null {
  const d = att.deposit;
  if (att.kind !== "route_quote" || !d || d.chain !== SOLANA_MAINNET) return null;
  if (d.memo !== null) return { ok: false, reason: "memo" };
  const a = att.asset;
  if (!a || a.asset_id !== d.origin_asset_id) return { ok: false, reason: "no_asset" };
  if (!isSolanaAddress(d.address) || !/^[1-9][0-9]{0,19}$/.test(d.amount_in) || BigInt(d.amount_in) > U64_MAX) {
    return { ok: false, reason: "token" };
  }
  const token = a.token;
  if (!token) return { ok: false, reason: "token" };
  if (a.asset_id === SOL_ASSET_ID) {
    if (token.standard !== "native" || token.address !== null || a.decimals !== 9)
      return { ok: false, reason: "token" };
    return { ok: true, recipe: { kind: "sol", deposit: d.address, lamports: d.amount_in } };
  }
  if (token.standard !== "spl" || token.address === null || !isSolanaAddress(token.address)) {
    return { ok: false, reason: "token" };
  }
  const omft = parseOmftAssetId(a.asset_id);
  if (omft?.blockchain !== "sol" || omft.kind !== "hash20" || omft.token !== splAssetToken(token.address)) {
    return { ok: false, reason: "mint_mismatch" };
  }
  return {
    ok: true,
    recipe: { kind: "spl", deposit: d.address, mint: token.address, decimals: a.decimals, amount: d.amount_in },
  };
}

/** The instructions of a recipe for `payer` (fee payer = the connected wallet). */
export function solanaInstructions(recipe: SolanaRecipe, payer: string): Instruction[] {
  pubkeyBytes(payer);
  if (recipe.kind === "sol") return [systemTransfer(payer, recipe.deposit, recipe.lamports)];
  const payerAta = associatedTokenAddress(payer, recipe.mint).address;
  const depositAta = associatedTokenAddress(recipe.deposit, recipe.mint).address;
  return [
    createAtaIdempotent(payer, depositAta, recipe.deposit, recipe.mint),
    transferChecked(payerAta, recipe.mint, depositAta, payer, recipe.amount, recipe.decimals),
  ];
}

// ---- legacy message + unsigned transaction ------------------------------------------------------------

function compactU16(n: number): number[] {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new RangeError("compact-u16 out of range");
  const out: number[] = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
}

/**
 * Compiles a legacy message: fee payer first, then writable signers, readonly signers, writable
 * non-signers, readonly non-signers (program ids are readonly non-signers).
 */
export function compileLegacyMessage(
  feePayer: string,
  instructions: readonly Instruction[],
  recentBlockhash: string,
): Uint8Array {
  const keys = new Map<string, { signer: boolean; writable: boolean }>();
  const add = (k: string, signer: boolean, writable: boolean) => {
    const cur = keys.get(k);
    keys.set(k, { signer: (cur?.signer ?? false) || signer, writable: (cur?.writable ?? false) || writable });
  };
  add(feePayer, true, true);
  for (const ix of instructions) {
    for (const a of ix.accounts) add(a.pubkey, a.isSigner, a.isWritable);
    add(ix.programId, false, false);
  }
  const entries = [...keys];
  const rank = ([k, m]: [string, { signer: boolean; writable: boolean }]) =>
    k === feePayer ? 0 : m.signer ? (m.writable ? 1 : 2) : m.writable ? 3 : 4;
  // Stable sort keeps first-seen order within each class.
  const ordered = entries.map((e, i) => ({ e, i })).sort((x, y) => rank(x.e) - rank(y.e) || x.i - y.i);
  const list = ordered.map((x) => x.e);
  const numSigners = list.filter(([, m]) => m.signer).length;
  const roSigned = list.filter(([, m]) => m.signer && !m.writable).length;
  const roUnsigned = list.filter(([, m]) => !m.signer && !m.writable).length;
  const index = new Map(list.map(([k], i) => [k, i]));
  const bytes: number[] = [numSigners, roSigned, roUnsigned, ...compactU16(list.length)];
  for (const [k] of list) bytes.push(...pubkeyBytes(k));
  bytes.push(...pubkeyBytes(recentBlockhash));
  bytes.push(...compactU16(instructions.length));
  for (const ix of instructions) {
    bytes.push(index.get(ix.programId) as number);
    bytes.push(...compactU16(ix.accounts.length));
    for (const a of ix.accounts) bytes.push(index.get(a.pubkey) as number);
    bytes.push(...compactU16(ix.data.length), ...ix.data);
  }
  return Uint8Array.from(bytes);
}

/** Wire transaction with empty signature slots (the wallet fills them). */
export function unsignedTransaction(message: Uint8Array): Uint8Array {
  const numSigners = message[0] as number;
  const prefix = compactU16(numSigners);
  const out = new Uint8Array(prefix.length + 64 * numSigners + message.length);
  out.set(prefix, 0);
  out.set(message, prefix.length + 64 * numSigners);
  return out;
}

/** The unsigned payment transaction for a recipe. */
export function solanaPaymentTransaction(recipe: SolanaRecipe, payer: string, recentBlockhash: string): Uint8Array {
  return unsignedTransaction(compileLegacyMessage(payer, solanaInstructions(recipe, payer), recentBlockhash));
}
