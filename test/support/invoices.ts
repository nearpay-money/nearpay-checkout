/** `PublicInvoice` fixtures (spec 0.4.0) shared by unit tests and the Playwright mock. */
import { PublicInvoice, safeParseTolerant } from "@nearpay/spec";
import type { z } from "zod";

/** spec 0.4.0 `PublicInvoice` (with `auto_debit`). */
export type InvoiceFixture = z.output<typeof PublicInvoice>;

export const INVOICE_ID = "in_01jbz9k3m4n5p6q7r8s9t0v1w2";
export const INVOICE_SECRET = `${INVOICE_ID}_secret_${"Kp7".repeat(10)}Qz`;

export function invoice(over: Partial<InvoiceFixture> = {}): InvoiceFixture {
  const inv: InvoiceFixture = {
    id: INVOICE_ID as `in_${string}`,
    object: "invoice",
    livemode: false,
    status: "open",
    number: "ACMEST-T-00041",
    payable: true,
    currency: "usd",
    asset_id: null,
    pricing_asset: null,
    display: {
      merchant_name_unverified: "Acme (unverified)",
      description: "Thanks for your business. Payment is due within 14 days.",
      footer: "Acme Studio GmbH · Musterstraße 1 · 10115 Berlin",
    },
    bill_to: { name: "Northstar Labs", email: "billing@northstar.example" },
    lines: [
      {
        description: "Acme Team plan",
        quantity: 1,
        unit_amount: 20750,
        amount: 20750,
        period: null,
        tax_amounts: [{ display_name: "VAT", jurisdiction: "DE", percentage: "20", inclusive: false, amount: 4150 }],
      },
    ],
    subtotal: 20750,
    tax: 4150,
    total: 24900,
    total_excluding_tax: 20750,
    total_tax_amounts: [{ display_name: "VAT", jurisdiction: "DE", percentage: "20", inclusive: false, amount: 4150 }],
    amount_due: 24900,
    amount_paid: 0,
    amount_remaining: 24900,
    issued_at: "2026-11-01T09:00:00.000Z",
    due_date: "2099-11-12T12:00:00.000Z",
    paid_at: null,
    voided_at: null,
    period_start: null,
    period_end: null,
    settlement: {
      asset_id: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      chain: "near:mainnet",
      type: "intents_account",
    },
    checkout_session: null,
    ...over,
  } as InvoiceFixture;
  // Tolerant: tests may use unknown open-enum statuses (as a newer billing could send).
  const r = safeParseTolerant(PublicInvoice, inv);
  if (!r.success) throw new Error(`invalid invoice fixture: ${JSON.stringify(r.error)}`);
  return inv;
}
