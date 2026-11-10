/** Hosted invoices `/i/:id#<invoice secret>` (Stage 3): states, PDF, pay hand-off into checkout, no oracle. */
import type { Page } from "@playwright/test";
import { USDC_BASE } from "../support/sessions";
import { a11yBasics } from "./support/a11y";
import { expect, test } from "./support/fixtures";
import type { MockInvoice, MockNearPay } from "./support/mock-server";
import { choose } from "./support/pay";

const REFUND = "0x52908400098527886E0F7030069857D2E4169EE7";

async function payManually(page: Page) {
  await expect(page.getByTestId("choose-path")).toBeVisible();
  await page.getByTestId("path-manual").click();
  await choose(page, "route_quote", USDC_BASE);
  await page.getByTestId("refund-address").fill(REFUND);
  await page.getByTestId("continue").click();
  await expect(page.getByTestId("manual-instructions")).toBeVisible();
}

async function open(page: Page, mock: MockNearPay, m: MockInvoice) {
  await page.goto(mock.invoiceUrl(m));
  await expect(page.getByTestId("invoice-page")).toBeVisible();
}

test("open invoice: number, status, amounts, taxes, memo, footer; no unverified merchant name", async ({
  page,
  mock,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const m = mock.createInvoice();
  await open(page, mock, m);
  await expect(page).toHaveTitle("Invoice ACMEST-T-00041 · NearPay");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Invoice ACMEST-T-00041");
  await expect(page.getByTestId("invoice-status")).toHaveText("Open");
  await expect(page.getByTestId("invoice-amount")).toHaveText("$249.00");
  await expect(page.getByTestId("invoice-date")).toHaveText("Due 12 November 2099");
  await expect(page.getByTestId("bill-to")).toHaveText("Northstar Labs");
  await expect(page.getByTestId("invoice-lines")).toContainText("Acme Team plan");
  await expect(page.getByTestId("invoice-lines")).toContainText("1 × $207.50");
  await expect(page.getByText("VAT (20%)")).toBeVisible();
  await expect(page.getByTestId("amount-due")).toHaveText("$249.00");
  await expect(page.getByTestId("invoice-memo")).toContainText("Thanks for your business");
  await expect(page.getByTestId("invoice-footer")).toContainText("Acme Studio GmbH");
  await expect(page.getByTestId("test-banner")).toContainText("Test mode — no real funds");
  await expect(page.getByTestId("invoice-pay")).toHaveText("Pay invoice");
  await expect(page.getByText("Payment fees will be shown before you approve.")).toBeVisible();
  // L-CK-03: the invoice's unverified merchant name is never rendered.
  await expect(page.getByText("Acme (unverified)")).toHaveCount(0);
  await expect(page.getByTestId("invoice-overdue")).toHaveCount(0);
  await a11yBasics(page);
  // The secret travels only in the header (never in a request URL, never stored).
  for (const c of mock.calls) expect(c.headers["x-nearpay-invoice-secret"]).toBe(m.secret);
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })),
  ).not.toContain("_secret_");
});

test("not found is identical for a wrong secret, an unknown id and malformed links (no oracle)", async ({
  page,
  mock,
}) => {
  const m = mock.createInvoice();
  const urls: string[] = [];
  page.on("request", (r) => urls.push(r.url()));
  const texts: string[] = [];
  const wrong = `${m.invoice.id}_secret_${"Q".repeat(32)}`;
  const unknownId = "in_01jbz9k3m4n5p6q7r8s9t0zzzz";
  for (const url of [
    `${mock.origin}/i/${m.invoice.id}#${wrong}`,
    `${mock.origin}/i/${unknownId}#${unknownId}_secret_${"Q".repeat(32)}`,
    `${mock.origin}/i/${m.invoice.id}`,
    `${mock.origin}/i/${m.invoice.id}#garbage`,
    `${mock.origin}/i/in_123#${m.secret}`,
  ]) {
    await page.goto("about:blank");
    await page.goto(url);
    await expect(page.getByTestId("invoice-not-found")).toBeVisible();
    texts.push(((await page.locator(".ck-flow").textContent()) ?? "").trim());
  }
  expect(new Set(texts).size).toBe(1);
  expect(texts[0]).toContain("Invoice not found");
  // Only the two well-formed links reached the API; malformed ones never did.
  expect(mock.callsTo("getPublicInvoice")).toHaveLength(2);
  expect(urls.some((u) => u.includes("_secret_") && !u.includes("#"))).toBe(false);
});

test("load failure offers a retry", async ({ page, mock }) => {
  const m = mock.createInvoice();
  let fail = true;
  await page.route("**/api/v1/invoices/*/public", (r) =>
    fail
      ? r.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"error":{"code":"api_error","type":"api_error","message":"x"}}',
        })
      : r.fallback(),
  );
  await page.goto(mock.invoiceUrl(m));
  await expect(page.getByTestId("invoice-load-failed")).toBeVisible();
  fail = false;
  await page.getByTestId("invoice-retry").click();
  await expect(page.getByTestId("invoice-page")).toBeVisible();
});

test("download PDF with the invoice-secret header; failures are shown", async ({ page, mock }) => {
  const m = mock.createInvoice();
  await open(page, mock, m);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("invoice-download").click()]);
  expect(download.suggestedFilename()).toBe("Invoice-ACMEST-T-00041.pdf");
  expect(mock.callsTo("getPublicInvoicePdf")[0]?.headers["x-nearpay-invoice-secret"]).toBe(m.secret);
  m.pdfStatus = 500;
  await page.getByTestId("invoice-download").click();
  await expect(page.getByTestId("download-error")).toContainText("couldn't download");
});

test("pay: hand-off into checkout, back to the invoice, continue the same session, paid receipt", async ({
  page,
  mock,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const m = mock.createInvoice({}, { sessionOpts: { autoSucceed: true } });
  await open(page, mock, m);
  await page.getByTestId("invoice-pay").click();
  await expect(page.getByTestId("choose-path")).toBeVisible();
  // The checkout shows the session amount and description; the URL keeps the invoice link.
  await expect(page.getByTestId("price")).toHaveText("$249.00");
  expect(page.url()).toBe(mock.invoiceUrl(m));
  // Back on the first screen returns to the invoice, which now offers to continue the open session.
  await page.getByRole("button", { name: "Back" }).first().click();
  await expect(page.getByTestId("invoice-pay")).toHaveText("Continue payment");
  await page.getByTestId("invoice-pay").click();
  await payManually(page);
  expect(m.sessions).toHaveLength(1); // reused, not a second session
  expect(mock.callsTo("createPublicInvoiceSession")).toHaveLength(2);
  // Checkout security rules unchanged: attested merchant, guarded address.
  await expect(page.locator(".np-checkout__merchant-name")).toHaveText("Acme GmbH");
  await expect(page.getByTestId("deposit-address")).toHaveCount(0);
  await page.getByTestId("confirm-network").check();
  await expect(page.getByTestId("deposit-address")).toBeVisible();
  await page.getByTestId("simulate").click();
  await expect(page.getByTestId("succeeded")).toBeVisible();
  // No redirect to the session's success_url (it has no secret); the payer views the paid invoice.
  await page.waitForTimeout(3000);
  expect(page.url()).toBe(mock.invoiceUrl(m));
  await page.getByTestId("view-invoice").click();
  await expect(page.getByTestId("invoice-paid")).toContainText("Invoice paid");
  await expect(page.getByTestId("invoice-paid")).toContainText("Acme GmbH has received your payment.");
  await expect(page.getByTestId("invoice-status")).toHaveText("Paid");
  await expect(page.getByTestId("invoice-pay")).toHaveCount(0);
  await expect(page.getByTestId("invoice-download")).toHaveText("Download receipt");
  await a11yBasics(page);
});

test("billing lag after payment: no second Pay while the invoice updates", async ({ page, mock }) => {
  const m = mock.createInvoice({}, { sessionOpts: { autoSucceed: true }, paidLagMs: 2500 });
  await open(page, mock, m);
  await page.getByTestId("invoice-pay").click();
  await payManually(page);
  await page.getByTestId("confirm-network").check();
  await page.getByTestId("simulate").click();
  await page.getByTestId("view-invoice").click();
  await expect(page.getByTestId("invoice-updating")).toBeVisible();
  await expect(page.getByTestId("invoice-pay")).toHaveCount(0);
  await expect(page.getByTestId("invoice-paid")).toBeVisible({ timeout: 10_000 });
});

test("overdue, uncollectible (still payable), not payable, void, paid", async ({ page, mock }) => {
  const overdue = mock.createInvoice({ due_date: "2026-01-05T12:00:00.000Z" });
  await open(page, mock, overdue);
  await expect(page.getByTestId("invoice-status")).toHaveText("Overdue");
  await expect(page.getByTestId("invoice-overdue")).toContainText("It was due on 5 January 2026.");
  await expect(page.getByTestId("invoice-pay")).toBeVisible();

  const unc = mock.createInvoice({ status: "uncollectible", due_date: "2026-01-05T12:00:00.000Z" });
  await open(page, mock, unc);
  await expect(page.getByTestId("invoice-status")).toHaveText("Past due");
  await expect(page.getByTestId("invoice-uncollectible")).toContainText("You can still pay it.");
  await expect(page.getByTestId("invoice-pay")).toBeVisible();

  const closed = mock.createInvoice({ payable: false });
  await open(page, mock, closed);
  await expect(page.getByTestId("invoice-unpayable")).toBeVisible();
  await expect(page.getByTestId("invoice-pay")).toHaveCount(0);

  const voided = mock.createInvoice({ status: "void", payable: false, voided_at: "2026-11-03T10:00:00.000Z" });
  await open(page, mock, voided);
  await expect(page.getByTestId("invoice-status")).toHaveText("Void");
  await expect(page.getByTestId("invoice-void")).toContainText("Nothing is due.");
  await expect(page.getByTestId("invoice-date")).toHaveText("Voided 3 November 2026");
  await expect(page.getByTestId("invoice-pay")).toHaveCount(0);
  await expect(page.getByTestId("invoice-download")).toHaveText("Download invoice");

  const paid = mock.createInvoice({
    status: "paid",
    payable: false,
    paid_at: "2026-11-04T10:00:00.000Z",
    amount_paid: 24900,
    amount_remaining: 0,
  });
  await open(page, mock, paid);
  await expect(page.getByTestId("invoice-paid")).toContainText("Paid on 4 November 2026.");
  await expect(page.getByTestId("invoice-amount")).toHaveText("$249.00");
  await expect(page.getByTestId("invoice-download")).toHaveText("Download receipt");
  await expect(page.getByTestId("amount-due")).toHaveCount(0);
});

test("expired payment session: start a new one", async ({ page, mock }) => {
  const m = mock.createInvoice();
  await open(page, mock, m);
  await page.getByTestId("invoice-pay").click();
  await expect(page.getByTestId("choose-path")).toBeVisible();
  const s = m.sessions[0];
  if (!s) throw new Error("no session");
  s.session.status = "expired";
  s.session.intent_status = "expired";
  mock.push(s, "session", s.session);
  await expect(page.getByTestId("invoice-session-expired")).toContainText("This payment session expired");
  await page.getByTestId("invoice-restart").click();
  await expect(page.getByTestId("choose-path")).toBeVisible();
  expect(m.sessions).toHaveLength(2);
});

test("a session refusal is explained and the invoice refreshed", async ({ page, mock }) => {
  const m = mock.createInvoice();
  await open(page, mock, m);
  m.sessionError = "destination_not_active";
  await page.getByTestId("invoice-pay").click();
  await expect(page.getByTestId("error")).toContainText("can't receive payments right now");
  // Voided meanwhile: invoice_not_payable → message, the page shows the void invoice.
  Object.assign(m.invoice, { status: "void", payable: false, voided_at: "2026-11-08T10:00:00.000Z" });
  m.sessionError = "invoice_not_payable";
  await page.getByTestId("invoice-pay").click();
  await expect(page.getByTestId("error")).toContainText("can't be paid any more");
  await expect(page.getByTestId("invoice-void")).toBeVisible();
});

test("desktop: invoice in the summary column, actions in the card; invoice summary during payment", async ({
  page,
  mock,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const m = mock.createInvoice({ livemode: true });
  await open(page, mock, m);
  await expect(page.getByTestId("test-banner")).toHaveCount(0);
  const doc = await page.getByTestId("invoice-document").boundingBox();
  const card = await page.getByTestId("invoice-actions").boundingBox();
  expect(doc && card && doc.x + doc.width <= card.x).toBe(true);
  await a11yBasics(page);
  await page.getByTestId("invoice-pay").click();
  await expect(page.getByTestId("choose-path")).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Invoice ACMEST-T-00041" })).toBeVisible();
  await expect(page.getByTestId("invoice-lines")).toContainText("Acme Team plan");
});
