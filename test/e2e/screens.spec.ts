/**
 * Screenshot tour of the main checkout screens at 1440 and 390 px (step 2.3 review against the Figma).
 * Runs only with NP_SHOTS=<dir> (e.g. `NP_SHOTS=/home/claude/shots/checkout pnpm exec playwright test screens`).
 */
import type { Page } from "@playwright/test";
import { USDC_BASE } from "../support/sessions";
import { expect, test } from "./support/fixtures";
import { MerchantSite } from "./support/merchant";
import type { MockNearPay, MockSession } from "./support/mock-server";
import { injectEvmWallet } from "./support/wallets";

const DIR = process.env.NP_SHOTS ?? "";
test.skip(!DIR, "screenshots only with NP_SHOTS");
test.describe.configure({ mode: "serial" });

const REFUND = "0x52908400098527886E0F7030069857D2E4169EE7";
const WIDTHS = [
  [1440, 900],
  [390, 844],
] as const;

async function shot(page: Page, name: string) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${DIR}/${name}-${page.viewportSize()?.width}.png`, fullPage: true });
}

async function manualTo(page: Page, mock: MockNearPay, s: MockSession, reveal = true) {
  await page.goto(mock.url(s));
  await page.getByTestId("path-manual").click();
  await page.getByTestId(`option-route_quote-${USDC_BASE}`).click();
  await page.getByTestId("refund-address").fill(REFUND);
  await page.getByTestId("continue").click();
  await expect(page.getByTestId("manual-instructions")).toBeVisible();
  if (reveal) await page.getByTestId("confirm-network").check();
}

for (const [w, h] of WIDTHS) {
  test.describe(`${w}px`, () => {
    test.beforeEach(async ({ page }) => page.setViewportSize({ width: w, height: h }));

    test("start, wallets, pay with, network, no match, refund form", async ({ page, mock }) => {
      await injectEvmWallet(page, { chainId: "0x2105" });
      const s = mock.create({ livemode: true });
      await page.goto(mock.url(s));
      await expect(page.getByTestId("choose-path")).toBeVisible();
      await shot(page, "01-start");
      await page.getByTestId("path-wallet").click();
      await expect(page.getByTestId("evm-wallet-test.mockwallet")).toBeVisible();
      await shot(page, "02-connect-wallet");
      await page.getByTestId("evm-wallet-test.mockwallet").click();
      await expect(page.getByTestId("asset-picker")).toBeVisible();
      await shot(page, "03-pay-with");
      await page.getByTestId("network-filter").click();
      await shot(page, "04-choose-network");
      await page.getByTestId("network-apply").click();
      await page.getByTestId("asset-search").fill("DOGE on Base");
      await shot(page, "05-no-matching-options");
      const m = mock.create();
      await page.goto(mock.url(m));
      await page.getByTestId("path-manual").click();
      await page.getByTestId(`option-route_quote-${USDC_BASE}`).click();
      await page.getByTestId("refund-address").fill("0x5290");
      await page.getByTestId("refund-address").blur();
      await shot(page, "06-send-from-another-wallet");
    });

    test("review, approve, dark, test mode, payment details", async ({ page, mock }) => {
      await injectEvmWallet(page, { chainId: "0x2105", sendError: "hang" });
      const s = mock.create({ livemode: true });
      await page.goto(mock.url(s));
      await page.getByTestId("path-wallet").click();
      await page.getByTestId("evm-wallet-test.mockwallet").click();
      await page.getByTestId(`option-route_quote-${USDC_BASE}`).click();
      await expect(page.getByTestId("wallet-send")).toBeVisible();
      await shot(page, "07-review");
      await page.getByTestId("payment-details").click();
      await shot(page, "08-payment-details");
      await page.keyboard.press("Escape");
      await page.getByTestId("wallet-send").click();
      await shot(page, "09-approve-in-wallet");
      await page.emulateMedia({ colorScheme: "dark" });
      const d = mock.create({ livemode: true });
      await page.goto(mock.url(d));
      await page.getByTestId("path-wallet").click();
      await page.getByTestId("evm-wallet-test.mockwallet").click();
      await page.getByTestId(`option-route_quote-${USDC_BASE}`).click();
      await expect(page.getByTestId("wallet-send")).toBeVisible();
      await shot(page, "10-review-dark");
      await page.emulateMedia({ colorScheme: "light" });
      const tm = mock.create();
      await page.goto(mock.url(tm));
      await page.getByTestId("path-wallet").click();
      await page.getByTestId("evm-wallet-test.mockwallet").click();
      await page.getByTestId(`option-route_quote-${USDC_BASE}`).click();
      await expect(page.getByTestId("simulate")).toBeVisible();
      await shot(page, "11-test-mode-try-a-payment");
    });

    test("verifying, verify failed, manual instructions, statuses", async ({ page, mock }) => {
      const v = mock.create({}, { attestDelayMs: 4000 });
      await page.goto(mock.url(v));
      await page.getByTestId("path-manual").click();
      await page.getByTestId(`option-route_quote-${USDC_BASE}`).click();
      await page.getByTestId("refund-address").fill(REFUND);
      await page.getByTestId("continue").click();
      await expect(page.getByTestId("verifying")).toBeVisible();
      await shot(page, "12-verifying");
      const f = mock.create({}, { sentinel: "tamper_address" });
      await page.goto(mock.url(f));
      await page.getByTestId("path-manual").click();
      await page.getByTestId(`option-route_quote-${USDC_BASE}`).click();
      await page.getByTestId("refund-address").fill(REFUND);
      await page.getByTestId("continue").click();
      await expect(page.getByTestId("verify-failed")).toBeVisible();
      await shot(page, "13-verify-failed");

      const s = mock.create({}, { memo: null });
      await manualTo(page, mock, s, false);
      await shot(page, "14-send-guarded");
      await page.getByTestId("confirm-network").check();
      await shot(page, "15-send-revealed");
      mock.setAttempt(s, { status: "incomplete_deposit" });
      await expect(page.getByTestId("top-up")).toBeVisible();
      await shot(page, "16-received-less");
      mock.setAttempt(s, { status: "deposit_detected", attestation_ticket: null });
      await expect(page.getByTestId("processing")).toBeVisible();
      await shot(page, "17-confirming");
      mock.setAttempt(s, { status: "held" });
      mock.setIntent(s, "requires_review");
      await expect(page.getByTestId("review")).toBeVisible();
      await shot(page, "18-under-review");

      const ok = mock.create({ success_url: "https://shop.example/thanks" });
      await manualTo(page, mock, ok);
      await page.getByTestId("sent").click();
      await expect(page.getByTestId("processing")).toBeVisible();
      await shot(page, "19-waiting");
      mock.succeed(ok);
      await expect(page.getByTestId("succeeded")).toBeVisible();
      await shot(page, "20-complete");
    });

    test("expiry, returns, no options, links, embed", async ({ page, mock }) => {
      const e = mock.create({}, { deadlineS: 3 });
      await manualTo(page, mock, e);
      await expect(page.getByTestId("expired-address")).toBeVisible({ timeout: 8000 });
      await shot(page, "21-address-expired");
      const r = mock.create();
      await manualTo(page, mock, r);
      mock.setAttempt(r, { status: "deposit_detected", attestation_ticket: null });
      mock.setAttempt(r, { status: "failed" });
      await expect(page.getByTestId("refunded")).toBeVisible();
      await shot(page, "22-being-returned");
      mock.setAttempt(r, { status: "refunded", refunded_amount: "1990000" });
      await expect(page.getByTestId("refunded-amount")).toBeVisible();
      await shot(page, "23-returned");
      const q = mock.create();
      await manualTo(page, mock, q);
      await page.getByTestId("sent").click();
      mock.setAttempt(q, { status: "expired_unpaid", attestation_ticket: null });
      await expect(page.getByTestId("quote-expired")).toBeVisible();
      await shot(page, "24-quote-expired");
      const n = mock.create({}, { options: [] });
      await page.goto(mock.url(n));
      await page.getByTestId("path-manual").click();
      await expect(page.getByTestId("no-options")).toBeVisible();
      await shot(page, "25-no-options");
      const l = mock.createLink({ collect_email: true });
      await page.goto(`${mock.origin}/l/${l.link.id}`);
      await expect(page.getByTestId("payment-link")).toBeVisible();
      await shot(page, "26-payment-link");
      const off = mock.createLink({ active: false });
      await page.goto(`${mock.origin}/l/${off.link.id}`);
      await expect(page.getByTestId("link-inactive")).toBeVisible();
      await shot(page, "27-payment-link-inactive");
      const merchant = new MerchantSite();
      await merchant.start();
      try {
        const em = mock.create({ ui_mode: "embedded", allowed_origins: [merchant.origin] });
        merchant.iframeSrc = mock.url(em, "embed");
        await page.goto(`${merchant.origin}/shop`);
        await expect(page.frameLocator("#np").getByTestId("choose-path")).toBeVisible();
        await shot(page, "28-embedded");
      } finally {
        await merchant.stop();
      }
    });

    test("hosted invoices", async ({ page, mock }) => {
      const open = mock.createInvoice({}, { sessionOpts: { autoSucceed: true } });
      await page.goto(mock.invoiceUrl(open));
      await expect(page.getByTestId("invoice-page")).toBeVisible();
      await shot(page, "30-invoice-open");
      await page.getByTestId("invoice-pay").click();
      await expect(page.getByTestId("choose-path")).toBeVisible();
      await shot(page, "31-invoice-pay-start");
      await page.getByTestId("path-manual").click();
      await page.getByTestId(`option-route_quote-${USDC_BASE}`).click();
      await page.getByTestId("refund-address").fill(REFUND);
      await page.getByTestId("continue").click();
      await expect(page.getByTestId("manual-instructions")).toBeVisible();
      await page.getByTestId("confirm-network").check();
      await shot(page, "32-invoice-pay-instructions");
      await page.getByTestId("simulate").click();
      await expect(page.getByTestId("succeeded")).toBeVisible();
      await shot(page, "33-invoice-payment-complete");
      await page.getByTestId("view-invoice").click();
      await expect(page.getByTestId("invoice-paid")).toBeVisible();
      await shot(page, "34-invoice-paid");
      const overdue = mock.createInvoice({
        livemode: true,
        due_date: "2026-11-01T12:00:00.000Z",
        lines: [
          {
            description: "Design retainer — November",
            quantity: 1,
            unit_amount: 150000,
            amount: 150000,
            period: { start: "2026-11-01T00:00:00.000Z", end: "2026-12-01T00:00:00.000Z" },
            tax_amounts: [],
          },
          {
            description: "Extra review rounds",
            quantity: 3,
            unit_amount: 12000,
            amount: 36000,
            period: null,
            tax_amounts: [],
          },
        ],
        subtotal: 186000,
        tax: 35340,
        total: 221340,
        total_excluding_tax: 186000,
        total_tax_amounts: [
          { display_name: "VAT", jurisdiction: "DE", percentage: "19", inclusive: false, amount: 35340 },
        ],
        amount_due: 221340,
        amount_paid: 0,
        amount_remaining: 221340,
      });
      await page.goto(mock.invoiceUrl(overdue));
      await expect(page.getByTestId("invoice-overdue")).toBeVisible();
      await shot(page, "35-invoice-overdue");
      const unc = mock.createInvoice({ status: "uncollectible", due_date: "2026-10-01T12:00:00.000Z" });
      await page.goto(mock.invoiceUrl(unc));
      await expect(page.getByTestId("invoice-uncollectible")).toBeVisible();
      await shot(page, "36-invoice-uncollectible");
      const voided = mock.createInvoice({ status: "void", payable: false, voided_at: "2026-11-03T12:00:00.000Z" });
      await page.goto(mock.invoiceUrl(voided));
      await expect(page.getByTestId("invoice-void")).toBeVisible();
      await shot(page, "37-invoice-void");
      await page.goto(`${mock.origin}/i/${open.invoice.id}#${open.invoice.id}_secret_${"Q".repeat(32)}`);
      await expect(page.getByTestId("invoice-not-found")).toBeVisible();
      await shot(page, "38-invoice-not-found");
      const exp = mock.createInvoice();
      await page.goto(mock.invoiceUrl(exp));
      await page.getByTestId("invoice-pay").click();
      await expect(page.getByTestId("choose-path")).toBeVisible();
      const es = exp.sessions[0] as MockSession;
      es.session.status = "expired";
      mock.push(es, "session", es.session);
      await expect(page.getByTestId("invoice-session-expired")).toBeVisible();
      await shot(page, "39-invoice-session-expired");
    });
  });
}
