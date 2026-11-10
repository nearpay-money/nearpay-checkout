/**
 * Amount formatting without floats (INV-5): base units are decimal strings, fiat amounts integer minor
 * units. Display strings only; nothing here feeds back into a money path.
 */

const BASE_UNITS = /^(0|[1-9][0-9]{0,77})$/;

/** `"2005013"`, 6 → `"2.005013"`; trailing zeros trimmed to `minFraction` digits. */
export function formatBaseUnits(amount: string, decimals: number, minFraction = 2): string {
  if (!BASE_UNITS.test(amount)) throw new RangeError(`not a base-unit amount: ${amount}`);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new RangeError(`bad decimals: ${decimals}`);
  if (decimals === 0) return groupThousands(amount);
  const padded = amount.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  let frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  const keep = Math.min(minFraction, decimals);
  if (frac.length < keep) frac = frac.padEnd(keep, "0");
  return frac ? `${groupThousands(whole)}.${frac}` : groupThousands(whole);
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Number of minor-unit digits of an ISO 4217 currency (USD 2, JPY 0, …). */
export function currencyExponent(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: currency.toUpperCase() }).resolvedOptions()
      .maximumFractionDigits as number;
  } catch {
    return 2;
  }
}

/** Fiat minor units → `"$2.00"`; formatted from a decimal string, never a float. */
export function formatFiat(minor: number, currency: string, locale = "en"): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new RangeError(`bad fiat amount: ${minor}`);
  const exp = currencyExponent(currency);
  const s = String(minor).padStart(exp + 1, "0");
  const decimal = exp === 0 ? s : `${s.slice(0, s.length - exp)}.${s.slice(s.length - exp)}`;
  const nf = new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase() });
  // Intl.NumberFormat v3 formats decimal strings exactly; the type only admits number/bigint.
  return nf.format(decimal as unknown as number);
}

/** Session price: fiat (`amount` integer minor units) or an asset (base-unit string + decimals/symbol). */
export function formatPrice(
  amount: number | string,
  currency: string,
  asset?: { readonly decimals: number; readonly symbol: string } | null,
): string {
  if (currency === "asset") {
    if (typeof amount !== "string") throw new RangeError("asset price must be base units");
    return asset ? `${formatBaseUnits(amount, asset.decimals)} ${asset.symbol}` : `${amount} base units`;
  }
  if (typeof amount !== "number") throw new RangeError("fiat price must be minor units");
  return formatFiat(amount, currency);
}

/** `a >= b` for base-unit strings. */
export function gte(a: string, b: string): boolean {
  return BigInt(a) >= BigInt(b);
}

/**
 * `amount` rounded UP to `digits` significant digits (base units), for "You need about 0.00002 ETH":
 * never understates what is needed.
 */
export function roundUpSignificant(amount: bigint, digits = 2): bigint {
  if (amount <= 0n) return 0n;
  const len = amount.toString().length;
  if (len <= digits) return amount;
  const unit = 10n ** BigInt(len - digits);
  return ((amount + unit - 1n) / unit) * unit;
}
