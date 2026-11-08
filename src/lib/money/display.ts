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
  /**
   * `attested` = from the sentinel signature; `pricing` = the session's / link's / invoice's
   * `pricing_asset` (spec 0.2.1, rails registry, not attested); `options` = payments' payment options.
   */
  readonly source: "attested" | "pricing" | "options";
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

interface PricingAssetLike {
  readonly asset_id: string;
  readonly symbol: string;
  readonly decimals: number;
}

/**
 * Display data of a pricing asset (`pricing_asset` on `PublicCheckoutSession`, `PublicPaymentLink` and
 * `PublicInvoice`, spec 0.2.1): used only when it describes `assetId`; older servers omit it.
 */
export function pricingAssetMeta(assetId: string | null, p: PricingAssetLike | null | undefined): AssetMeta | null {
  if (!assetId || !p || p.asset_id !== assetId) return null;
  return { asset_id: assetId, symbol: p.symbol, decimals: p.decimals, source: "pricing" };
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

const BASE_UNITS_RE = /^(0|[1-9][0-9]{0,77})$/;

/**
 * Payer fee shown as "Payment fees": Intents transfers state it in the attested requirement; route
 * quotes carry `DepositInstructions.fee_amount` (spec 0.2.1) — display only, NOT attested, so it is
 * read from the verified attempt's own instructions and shown only when it is a well-formed part of
 * the attested `amount_in` (else "Included in total"). `"0"` = the merchant bears the fee.
 */
export function payerFee(
  att: Attestation,
  attempt: {
    readonly id: string;
    readonly deposit: { readonly amount_in: string; readonly fee_amount?: string | null | undefined } | null;
  } | null,
): string | null {
  if (att.kind === "intents_transfer") return att.requirement?.fee_amount ?? null;
  const fee = attempt && attempt.id === att.attempt_id ? attempt.deposit?.fee_amount : null;
  const total = att.deposit?.amount_in;
  if (typeof fee !== "string" || !total || !BASE_UNITS_RE.test(fee)) return null;
  if (attempt?.deposit?.amount_in !== total || BigInt(fee) > BigInt(total)) return null;
  return fee;
}

/**
 * "We received less than expected" (`incomplete_deposit`): what arrived (`PayerAttempt.amount_received`,
 * spec 0.2.1, display only) and what is still missing of the attested amount. Null when unknown or
 * malformed; `remaining` null unless the received amount is below the attested one.
 */
export function receivedSoFar(
  attested: string,
  received: string | null | undefined,
): { readonly received: string; readonly remaining: string | null } | null {
  if (typeof received !== "string" || !BASE_UNITS_RE.test(received) || !BASE_UNITS_RE.test(attested)) return null;
  const diff = BigInt(attested) - BigInt(received);
  return { received, remaining: diff > 0n ? diff.toString() : null };
}

/**
 * Token contract for the wallet transfer: the attested `Attestation.asset.token` (spec 0.2.1, signed)
 * when sentinel sends it — `null` there means "no registry contract" (the attested asset id's derived
 * recipe still applies) — else the payment option's unattested `token` (CR-15-06).
 */
export function walletTokenHint<T>(
  att: Pick<Attestation, "asset"> | null,
  optionToken: T | null | undefined,
): NonNullable<Attestation["asset"]>["token"] | T | null | undefined {
  const attested = att?.asset?.token;
  return attested !== undefined ? attested : optionToken;
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
