/** Hosted invoices (Stage 3): route parsing, display logic, invoice-secret transport, binary PDF. */
import { createPublicInvoiceSession, getPublicInvoice, getPublicInvoicePdf } from "@nearpay-money/spec";
import { describe, expect, it, vi } from "vitest";
import { parseRoute } from "../../src/app/route";
import { call, callBinary, isApiError } from "../../src/lib/api/client";
import {
  billToText,
  formatDate,
  formatPeriod,
  heroAmount,
  invoiceLink,
  invoiceMoney,
  invoiceStatus,
  isZero,
  pdfFilename,
  rawAmount,
  taxLabelKey,
} from "../../src/routes/invoice/model";
import { INVOICE_ID, INVOICE_SECRET, invoice } from "../support/invoices";

const NOW = Date.parse("2026-11-08T12:00:00Z");

describe("invoice route", () => {
  const link = (path: string, hash: string) => {
    const r = parseRoute(path, hash);
    return r.kind === "invoice" && r.invoice ? invoiceLink(r.invoice.id, r.invoice.secret) : null;
  };
  it("accepts only a well-formed id with its own secret", () => {
    expect(parseRoute(`/i/${INVOICE_ID}`, `#${INVOICE_SECRET}`)).toEqual({
      kind: "invoice",
      invoice: { id: INVOICE_ID, secret: INVOICE_SECRET },
    });
    expect(link(`/i/${INVOICE_ID}`, `#${INVOICE_SECRET}`)).toEqual({ id: INVOICE_ID, secret: INVOICE_SECRET });
    expect(link(`/i/${INVOICE_ID}/`, `#${INVOICE_SECRET}`)).toMatchObject({ id: INVOICE_ID });
    // Missing, malformed or foreign secrets and bad ids → null (the page shows "not found", no API call).
    expect(link(`/i/${INVOICE_ID}`, "")).toBeNull();
    expect(link(`/i/${INVOICE_ID}`, "#nope")).toBeNull();
    const other = `in_01jbz9k3m4n5p6q7r8s9t0v1w3_secret_${"A".repeat(32)}`;
    expect(link(`/i/${INVOICE_ID}`, `#${other}`)).toBeNull();
    expect(parseRoute("/i/in_bad", `#${INVOICE_SECRET}`)).toEqual({ kind: "invoice", invoice: null });
    // A checkout client secret is not an invoice secret.
    expect(link(`/i/${INVOICE_ID}`, `#cs_01jbz9k3m4n5p6q7r8s9t0v1w2_secret_${"A".repeat(32)}`)).toBeNull();
  });
});

describe("invoice status", () => {
  it("open, overdue, uncollectible (still payable), paid, void, unknown", () => {
    expect(invoiceStatus(invoice(), NOW)).toEqual({
      kind: "open",
      payable: true,
      overdue: false,
      badge: { label: "invoice.status.open", tone: "warning" },
    });
    expect(invoiceStatus(invoice({ due_date: "2026-11-01T00:00:00Z" }), NOW)).toMatchObject({
      kind: "open",
      payable: true,
      overdue: true,
      badge: { label: "invoice.status.overdue", tone: "danger" },
    });
    expect(invoiceStatus(invoice({ status: "uncollectible" }), NOW)).toMatchObject({
      kind: "uncollectible",
      payable: true,
      badge: { label: "invoice.status.uncollectible" },
    });
    expect(invoiceStatus(invoice({ status: "paid", payable: false }), NOW)).toMatchObject({
      kind: "paid",
      payable: false,
      overdue: false,
      badge: { tone: "success" },
    });
    expect(invoiceStatus(invoice({ status: "void", payable: false }), NOW)).toMatchObject({
      kind: "void",
      payable: false,
      badge: { tone: "neutral" },
    });
    // Billing says not payable (e.g. account not accepting payments): no Pay button.
    expect(invoiceStatus(invoice({ payable: false }), NOW)).toMatchObject({ kind: "open", payable: false });
    // Unknown open-enum status: never payable here, no badge.
    expect(invoiceStatus(invoice({ status: "partially_paid" as never }), NOW)).toEqual({
      kind: "unknown",
      payable: false,
      overdue: false,
      badge: null,
    });
    // A paid invoice is never overdue, a missing/garbled due date never makes one overdue.
    expect(invoiceStatus(invoice({ status: "paid", due_date: "2026-01-01T00:00:00Z" }), NOW).overdue).toBe(false);
    expect(invoiceStatus(invoice({ due_date: null }), NOW).overdue).toBe(false);
  });
});

describe("invoice amounts", () => {
  it("formats fiat minor units and asset base units without floats", () => {
    expect(invoiceMoney(invoice(), 24900)).toMatchObject({ amount: "24900", decimals: 2, symbol: "$" });
    const asset = invoice({
      currency: "asset",
      asset_id: "nep141:usdc.near",
      pricing_asset: { asset_id: "nep141:usdc.near", symbol: "USDC", decimals: 6 },
      subtotal: "1",
      tax: "0",
      total: "1",
      total_excluding_tax: "1",
      amount_due: "1",
      amount_paid: "0",
      amount_remaining: "1",
      lines: [],
      total_tax_amounts: [],
    } as never);
    expect(invoiceMoney(asset, "12345678901234567890")).toEqual({
      amount: "12345678901234567890",
      decimals: 6,
      symbol: "USDC",
    });
    expect(invoiceMoney({ ...asset, pricing_asset: null }, "5")).toBeNull();
    expect(rawAmount("5")).toBe("5 base units");
  });

  it("hero amount: remaining when payable, paid when paid, else the total", () => {
    const inv = invoice({ amount_paid: 900, amount_remaining: 24000 });
    expect(heroAmount(inv, "open")).toBe(24000);
    expect(heroAmount(inv, "uncollectible")).toBe(24000);
    expect(heroAmount({ ...inv, amount_paid: 24900 }, "paid")).toBe(24900);
    expect(heroAmount({ ...inv, amount_paid: 0 }, "paid")).toBe(24900);
    expect(heroAmount(inv, "void")).toBe(24900);
    expect(isZero(0)).toBe(true);
    expect(isZero("000")).toBe(true);
    expect(isZero("10")).toBe(false);
  });
});

describe("invoice texts", () => {
  it("dates, periods, tax labels, file names, bill-to", () => {
    expect(formatDate("2026-11-12T10:00:00Z", "en-GB", "UTC")).toBe("12 November 2026");
    expect(formatDate("garbage")).toBe("");
    expect(formatPeriod("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z", "en-GB", "UTC")).toMatch(/1.*30 November 2026/);
    expect(formatPeriod("x", "y")).toBe("");
    expect(taxLabelKey(true)).toBe("invoice.taxRateIncl");
    expect(taxLabelKey(false)).toBe("invoice.taxRate");
    expect(pdfFilename("ACMEST-T-00041")).toBe("Invoice-ACMEST-T-00041.pdf");
    expect(pdfFilename("../../etc/passwd")).toBe("Invoice-..-..-etc-passwd.pdf");
    expect(pdfFilename("///")).toBe("Invoice-invoice.pdf");
    expect(billToText(invoice())).toBe("Northstar Labs");
    expect(billToText(invoice({ bill_to: { name: null, email: "a@b.example" } }))).toBe("a@b.example");
    expect(billToText(invoice({ bill_to: { name: " ", email: null } }))).toBeNull();
  });
});

describe("invoice API calls", () => {
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  it("sends the invoice secret only as X-NearPay-Invoice-Secret, never in the URL", async () => {
    const doFetch = vi.fn(async (_url: string, _init: RequestInit) => json(200, invoice()));
    const inv = await call(
      getPublicInvoice,
      { params: { id: INVOICE_ID }, invoiceSecret: INVOICE_SECRET },
      doFetch as unknown as typeof fetch,
    );
    expect(inv.number).toBe("ACMEST-T-00041");
    const [url, init] = doFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/v1/invoices/${INVOICE_ID}/public`);
    expect(url).not.toContain("secret");
    expect((init.headers as Record<string, string>)["X-NearPay-Invoice-Secret"]).toBe(INVOICE_SECRET);
    expect((init.headers as Record<string, string>)["X-NearPay-Client-Secret"]).toBeUndefined();
    expect(init.referrerPolicy).toBe("no-referrer");
    expect(init.credentials).toBe("omit");
  });

  it("refuses to send a missing or malformed invoice secret", async () => {
    const doFetch = vi.fn();
    await expect(
      call(getPublicInvoice, { params: { id: INVOICE_ID } }, doFetch as unknown as typeof fetch),
    ).rejects.toThrow(RangeError);
    await expect(
      call(getPublicInvoice, { params: { id: INVOICE_ID }, invoiceSecret: "x" }, doFetch as unknown as typeof fetch),
    ).rejects.toThrow(RangeError);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("maps invoice errors", async () => {
    const doFetch = vi.fn(async () =>
      json(409, { error: { type: "state_conflict", code: "invoice_not_payable", message: "void" } }),
    );
    const e = await call(
      createPublicInvoiceSession,
      { params: { id: INVOICE_ID }, body: {}, invoiceSecret: INVOICE_SECRET },
      doFetch as unknown as typeof fetch,
    ).catch((x: unknown) => x);
    expect(isApiError(e, "invoice_not_payable")).toBe(true);
  });

  it("downloads the PDF as a blob of the declared type only", async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const ok = vi.fn(
      async (_u: string, _i: RequestInit) =>
        new Response(pdf, { status: 200, headers: { "content-type": "application/pdf" } }),
    );
    const blob = await callBinary(
      getPublicInvoicePdf,
      { params: { id: INVOICE_ID }, invoiceSecret: INVOICE_SECRET },
      ok as unknown as typeof fetch,
    );
    expect(blob.type).toBe("application/pdf");
    expect(blob.size).toBe(4);
    expect(((ok.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>).Accept).toContain(
      "application/pdf",
    );
    const html = vi.fn(async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }));
    const e = await callBinary(
      getPublicInvoicePdf,
      { params: { id: INVOICE_ID }, invoiceSecret: INVOICE_SECRET },
      html as unknown as typeof fetch,
    ).catch((x: unknown) => x);
    expect(isApiError(e, "invalid_response")).toBe(true);
    await expect(callBinary(getPublicInvoice, {}, ok as unknown as typeof fetch)).rejects.toThrow(RangeError);
  });
});
