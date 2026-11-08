/**
 * Display model shared by the screens: price, attested merchant/destination, asset metadata, totals and
 * the payment reference. Everything shown as "who you pay" comes from a verified attestation; the
 * unverified display name of the session is never read here (L-CK-03).
 */
import { formatMoney, type MoneyFormatOptions } from "@nearpay-internal/ui";
import { chainName } from "../lib/chains/chains";
import { type AssetMeta, assetMeta, payerFee, priceMoney, pricingAssetMeta, totalToSend } from "../lib/money/display";
import type { Checkout } from "./useCheckout";

export interface ViewModel {
  readonly testMode: boolean;
  /** Price hero (session price), null when it can't be formatted (asset pricing without metadata). */
  readonly price: MoneyFormatOptions | null;
  /** Price as plain text (always available; falls back to base units). */
  readonly priceText: string;
  readonly description: string | null;
  /** Attested merchant (legal name approved by ops) and whether ops reviewed the business details. */
  readonly merchant: { readonly name: string; readonly reviewed: boolean } | null;
  readonly destination: { readonly assetLabel: string; readonly chain: string; readonly fingerprint: string } | null;
  /** Paid asset metadata (attested when available). */
  readonly asset: AssetMeta | null;
  /** Attested total the payer sends and its chain (instructions screens only). */
  readonly total: string | null;
  readonly fee: string | null;
  readonly chain: string | null;
  /** Payment reference shown in callouts and copied by "Copy payment reference". */
  readonly reference: string | null;
}

/** "Reference pi_01jb…v1w2 · Acme GmbH" text. */
export function referenceText(ref: string, merchant: string | null): string {
  const short = ref.length > 18 ? `${ref.slice(0, 9)}…${ref.slice(-4)}` : ref;
  return merchant ? `Reference ${short} · ${merchant}` : `Reference ${short}`;
}

/** Money options as text ("$2.00", "2.005013 USDC"), or `fallback` without metadata. */
export function moneyText(m: MoneyFormatOptions | null, fallback: string): string {
  return m ? formatMoney(m) : fallback;
}

export function buildModel(c: Checkout): ViewModel {
  const s = c.state.session;
  const att = c.state.verified?.attestation ?? c.trusted?.attestation ?? null;
  const options = [c.state.option, c.originMeta, ...(c.state.options ?? [])];
  // Asset-priced sessions: attested display data for the same asset wins, then the session's
  // `pricing_asset` (spec 0.2.1), then the payment options.
  const pricing = s?.asset_id
    ? (assetMeta(s.asset_id, att, []) ??
      pricingAssetMeta(s.asset_id, s.pricing_asset) ??
      assetMeta(s.asset_id, null, options))
    : null;
  const price = s ? priceMoney(s, pricing) : null;
  const priceText = s ? moneyText(price, `${String(s.amount)} base units`) : "";
  const destAsset = att ? assetMeta(att.destination.asset_id, null, options) : null;
  return {
    testMode: s ? !s.livemode : false,
    price,
    priceText,
    description: s?.display.description ?? null,
    merchant: att ? { name: att.merchant.name, reviewed: att.merchant.kyb_verified } : null,
    destination: att
      ? {
          assetLabel: `${destAsset?.symbol ?? shortAsset(att.destination.asset_id)} · ${chainName(att.destination.chain)}`,
          chain: att.destination.chain,
          fingerprint: att.destination.fingerprint,
        }
      : null,
    asset: c.assetMeta,
    total: c.state.verified ? totalToSend(c.state.verified.attestation) : null,
    fee: c.state.verified ? payerFee(c.state.verified.attestation, c.state.attempt) : null,
    chain: c.state.verified
      ? (c.state.verified.attestation.deposit?.chain ?? "near:mainnet")
      : (c.trusted?.attestation.deposit?.chain ?? (c.trusted ? "near:mainnet" : null)),
    reference: s?.payment_intent ?? null,
  };
}

/** Readable fallback for an asset id without metadata ("nep141:usdc.near" → "usdc.near"). */
function shortAsset(id: string): string {
  const bare = id.replace(/^nep\d+:/, "");
  return bare.length > 20 ? `${bare.slice(0, 8)}…${bare.slice(-6)}` : bare;
}

/** Network label of the attested instructions ("NEAR Intents" for Intents transfers). */
export function instructionsNetwork(c: Checkout): string {
  const att = c.state.verified?.attestation ?? c.trusted?.attestation;
  if (!att) return "";
  return att.kind === "intents_transfer" ? "NEAR Intents" : chainName(att.deposit?.chain ?? "");
}
