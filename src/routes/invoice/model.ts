/**
 * Hosted invoice `/i/:id` (Stage 3, lld/checkout-and-js.md §4.3, lld/billing.md §5/§11): pure display
 * logic over the read-only `PublicInvoice` — status, payability, overdue, amounts (INV-5: integer minor
 * units or base-unit strings through the ui `Money`, never floats), dates, tax labels. Unit-tested.
 *
 * The invoice's `display.merchant_name_unverified` is never read here (L-CK-03): who is paid is shown
 * only from the sentinel attestation once a payment attempt is verified, exactly as in checkout.
 */

import type { MoneyFormatOptions, Tone } from "@nearpay-internal/ui";
import type { PublicInvoice } from "@nearpay-money/spec";
import { InvoiceSecret } from "@nearpay-money/spec";
import type { z } from "zod";
import type { MessageKey } from "../../lib/i18n/messages.en";
import { priceMoney, pricingAssetMeta } from "../../lib/money/display";

export type Invoice = z.output<typeof PublicInvoice>;
type Amount = Invoice["total"];

/**
 * The invoice link is usable only when the fragment is a well-formed invoice secret (spec
 * `InvoiceSecret`) that belongs to the id in the path. Otherwise the page shows the same "not found" as
 * for a wrong secret, without calling the API (no oracle).
 */
export function invoiceLink(id: string, secret: string): { readonly id: string; readonly secret: string } | null {
  return InvoiceSecret.safeParse(secret).success && secret.startsWith(`${id}_secret_`) ? { id, secret } : null;
}

export type InvoiceKind = "open" | "uncollectible" | "paid" | "void" | "unknown";

export interface InvoiceStatusView {
  readonly kind: InvoiceKind;
  /** The customer can start or continue a payment now. */
  readonly payable: boolean;
  /** `open` (or `uncollectible`) and past its due date. */
  readonly overdue: boolean;
  /** Status badge (explicit label + tone, never colour alone); null for unknown statuses. */
  readonly badge: { readonly label: MessageKey; readonly tone: Tone } | null;
}

const KNOWN: ReadonlySet<string> = new Set(["open", "uncollectible", "paid", "void"]);

/**
 * Status of the hosted page. Payable only when billing says so (`payable`) AND the status is one that
 * can be paid (`open`, `uncollectible` — INV-3: an uncollectible invoice still accepts payment); an
 * unknown status (open enum) is never payable here.
 */
export function invoiceStatus(inv: Pick<Invoice, "status" | "payable" | "due_date">, now: number): InvoiceStatusView {
  const kind: InvoiceKind = KNOWN.has(inv.status) ? (inv.status as InvoiceKind) : "unknown";
  const payable = inv.payable && (kind === "open" || kind === "uncollectible");
  const due = inv.due_date ? Date.parse(inv.due_date) : Number.NaN;
  const overdue = (kind === "open" || kind === "uncollectible") && Number.isFinite(due) && due < now;
  const badge: InvoiceStatusView["badge"] =
    kind === "paid"
      ? { label: "invoice.status.paid", tone: "success" }
      : kind === "void"
        ? { label: "invoice.status.void", tone: "neutral" }
        : kind === "uncollectible"
          ? { label: "invoice.status.uncollectible", tone: "warning" }
          : kind === "open"
            ? overdue
              ? { label: "invoice.status.overdue", tone: "danger" }
              : { label: "invoice.status.open", tone: "warning" }
            : null;
  return { kind, payable, overdue, badge };
}

/** Money options for an invoice amount (fiat minor units, or base units of the pricing asset). */
export function invoiceMoney(
  inv: Pick<Invoice, "currency" | "asset_id" | "pricing_asset">,
  amount: Amount,
): MoneyFormatOptions | null {
  return priceMoney(
    { amount, currency: inv.currency, asset_id: inv.asset_id },
    pricingAssetMeta(inv.asset_id, inv.pricing_asset),
  );
}

/** Plain-text fallback when an amount can't be formatted (asset pricing without display data). */
export function rawAmount(amount: Amount): string {
  return `${String(amount)} base units`;
}

/** The amount hero: what is still due (payable), what was paid (paid), else the total. */
export function heroAmount(
  inv: Pick<Invoice, "amount_remaining" | "amount_paid" | "total">,
  kind: InvoiceKind,
): Amount {
  if (kind === "paid") return isZero(inv.amount_paid) ? inv.total : inv.amount_paid;
  if (kind === "open" || kind === "uncollectible") return inv.amount_remaining;
  return inv.total;
}

export function isZero(a: Amount): boolean {
  return typeof a === "number" ? a === 0 : /^0+$/.test(a);
}

/** "12 November 2026" in the payer's time zone; "" for a malformed timestamp. */
export function formatDate(iso: string, locale = "en-GB", timeZone?: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    ...(timeZone ? { timeZone } : {}),
  }).format(t);
}

/**
 * "1–30 November 2026" for a service period (`end` exclusive: shown as the day before). Billing periods
 * are UTC boundaries (lld/billing.md §11 d9), so they are shown in UTC, not the payer's zone.
 */
export function formatPeriod(start: string, end: string, locale = "en-GB", timeZone = "UTC"): string {
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return "";
  const last = e > s ? e - 1 : e;
  const f = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric", timeZone });
  return f.formatRange(s, last);
}

/** Tax row label: "VAT (20%)", or "VAT (20% included)" for inclusive rates. */
export function taxLabelKey(inclusive: boolean): MessageKey {
  return inclusive ? "invoice.taxRateIncl" : "invoice.taxRate";
}

/** File name of the downloaded PDF: `Invoice-<number>.pdf` with only safe characters. */
export function pdfFilename(number: string): string {
  const safe = number
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return `Invoice-${safe || "invoice"}.pdf`;
}

/** Who is billed: the customer name, else their email (only the secret holder sees `bill_to`). */
export function billToText(inv: Pick<Invoice, "bill_to">): string | null {
  return inv.bill_to.name?.trim() || inv.bill_to.email?.trim() || null;
}
