/**
 * Display data for the ui `Money` / `formatMoney` helpers (INV-5: base units + decimals, never floats).
 *
 * Asset decimals and symbol come from sentinel's attestation when it carries them (`Attestation.asset`,
 * spec 0.2.0, CR-15-07 — verified to describe the paid asset), else from the payment options (not
 * attested; lld/checkout-and-js.md §10). Displayed totals are always the ATTESTED amounts.
 */
import type { Attestation } from "@nearpay/spec";
import type { MoneyFormatOptions } from "@nearpay-internal/ui";
import { currencyExponent } from "./format";

export interface AssetMeta {
  readonly asset_id: string;
  readonly symbol: string;
  readonly decimals: number;
  /** `attested` = from the sentinel signature; `options` = from payments' payment options. */
  readonly source: "attested" | "options";
}

interface OptionLike {
  readonly origin_asset_id: string;
  readonly symbol: string;
  readonly decimals: number;
}

/** Decimals/symbol of `assetId`: the attested values win, then the first option for that asset. */
export function assetMeta(
  assetId: string,
  attestation: Pick<Attestation, "asset"> | null,
  options: readonly (OptionLike | null)[],
): AssetMeta | null {
  const a = attestation?.asset;
  if (a && a.asset_id === assetId)
    return { asset_id: assetId, symbol: a.symbol, decimals: a.decimals, source: "attested" };
  const o = options.find((x) => x?.origin_asset_id === assetId);
  return o ? { asset_id: assetId, symbol: o.symbol, decimals: o.decimals, source: "options" } : null;
}

/** Asset the payer sends, per the attestation. */
export function paidAssetId(att: Attestation): string | null {
  return att.deposit?.origin_asset_id ?? att.requirement?.token ?? null;
}

/** Base units the payer sends (route: `amount_in`; Intents transfer: amount + fee). */
export function totalToSend(att: Attestation): string | null {
  if (att.kind === "route_quote") return att.deposit?.amount_in ?? null;
  if (!att.requirement) return null;
  return (BigInt(att.requirement.amount) + BigInt(att.requirement.fee_amount)).toString();
}

/** Payer fee the attestation states separately (Intents transfers only; route quotes include it). */
export function statedFee(att: Attestation): string | null {
  return att.kind === "intents_transfer" ? (att.requirement?.fee_amount ?? null) : null;
}

/** Amount options for an asset amount; null without metadata (the caller shows raw base units). */
export function assetMoney(amount: string, meta: AssetMeta | null): MoneyFormatOptions | null {
  return meta ? { amount, decimals: meta.decimals, symbol: meta.symbol } : null;
}

/** Currency symbol for display ("$", "€", "CHF"); falls back to the upper-case code. */
export function currencySymbol(currency: string): string {
  const code = currency.toUpperCase();
  try {
    const parts = new Intl.NumberFormat("en", {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
    }).formatToParts(0);
    return parts.find((p) => p.type === "currency")?.value ?? code;
  } catch {
    return code;
  }
}

interface PriceLike {
  readonly amount: number | string;
  readonly currency: string;
  readonly asset_id: string | null;
}

/** Session / link price as Money options: fiat minor units, or base units of the pricing asset. */
export function priceMoney(p: PriceLike, pricingAsset: AssetMeta | null): MoneyFormatOptions | null {
  if (p.currency === "asset") {
    if (typeof p.amount !== "string" || !pricingAsset) return null;
    return { amount: p.amount, decimals: pricingAsset.decimals, symbol: pricingAsset.symbol };
  }
  if (typeof p.amount !== "number" || !Number.isSafeInteger(p.amount) || p.amount < 0) return null;
  const exp = currencyExponent(p.currency);
  return { amount: String(p.amount), decimals: exp, symbol: currencySymbol(p.currency), minFraction: exp };
}
