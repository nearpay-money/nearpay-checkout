/**
 * Design v2 screenshot tour at 1440 and 390 px (owner review against the approved artboard
 * `Checkout-proposed`): review step, pickers open, gas warning, confirming, complete, dark review and
 * the hosted invoice page. Runs only with NP_SHOTS=<dir>
 * (`NP_SHOTS=/home/claude/shots/v2-checkout pnpm exec playwright test screens-v2`).
 */
import type { Page } from "@playwright/test";
import { USDC_BASE } from "../support/sessions";
import { expect, test } from "./support/fixtures";
import type { MockNearPay } from "./support/mock-server";
import { BASE_OPTIONS, RICH } from "./support/options";
import { choose, openPicker } from "./support/pay";
import { type EvmReads, injectEvmWallet } from "./support/wallets";

const DIR = process.env.NP_SHOTS ?? "";
test.skip(!DIR, "screenshots only with NP_SHOTS");
test.describe.configure({ mode: "serial" });

const WIDTHS = [
  [1440, 900],
  [390, 844],
] as const;
const REFUND = "0x52908400098527886E0F7030069857D2E4169EE7";
const SITE = { success_url: "https://acme.example/thanks", livemode: true } as const;

async function shot(page: Page, name: string) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${DIR}/${name}-${page.viewportSize()?.width}.png`, fullPage: true });
}

async function toReview(page: Page, mock: MockNearPay, reads: EvmReads = RICH) {
  await injectEvmWallet(page, { chainId: "0x2105", reads });
  const s = mock.create(SITE, { options: BASE_OPTIONS });
  await page.goto(mock.url(s));
  await page.getByTestId("path-wallet").click();
  await page.getByTestId("evm-wallet-test.mockwallet").click();
  await expect(page.getByTestId("token-picker-trigger")).toContainText("12.34");
  return s;
}

for (const [w, h] of WIDTHS) {
  test.describe(`${w}px`, () => {
    test.beforeEach(async ({ page }) => page.setViewportSize({ width: w, height: h }));

    test("pickers open, review", async ({ page, mock }) => {
      await toReview(page, mock);
      await openPicker(page, "token-picker");
      await shot(page, "v2-pickers-open");
      await page.keyboard.press("Escape");
      await choose(page, "route_quote", USDC_BASE);
      await expect(page.getByTestId("wallet-send")).toBeVisible();
      await expect(page.getByTestId("review-wallet")).toContainText("balance covers the network fee");
      await shot(page, "v2-review");
    });

    test("gas warning", async ({ page, mock }) => {
      await toReview(page, mock, { ...RICH, native: "0x0" });
      await choose(page, "route_quote", USDC_BASE);
      await expect(page.getByTestId("gas-warning")).toBeVisible();
      await shot(page, "v2-gas-warning");
    });

    test("dark review", async ({ page, mock }) => {
      await page.emulateMedia({ colorScheme: "dark" });
      await toReview(page, mock);
      await choose(page, "route_quote", USDC_BASE);
      await expect(page.getByTestId("review-wallet")).toContainText("balance covers the network fee");
      await shot(page, "v2-dark-review");
    });

    test("confirming, complete", async ({ page, mock }) => {
      const s = mock.create({ success_url: "https://acme.example/thanks" }, { memo: null });
      await page.goto(mock.url(s));
      await page.getByTestId("path-manual").click();
      await choose(page, "route_quote", USDC_BASE);
      await page.getByTestId("refund-address").fill(REFUND);
      await page.getByTestId("continue").click();
      await expect(page.getByTestId("manual-instructions")).toBeVisible();
      mock.setAttempt(s, { status: "deposit_detected", attestation_ticket: null });
      await expect(page.getByTestId("processing")).toBeVisible();
      await shot(page, "v2-confirming");
      mock.succeed(s);
      await expect(page.getByTestId("succeeded")).toBeVisible();
      await shot(page, "v2-complete");
    });

    test("invoice page", async ({ page, mock }) => {
      const inv = mock.createInvoice({
        livemode: true,
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
      await page.goto(mock.invoiceUrl(inv));
      await expect(page.getByTestId("invoice-page")).toBeVisible();
      await shot(page, "v2-invoice");
    });
  });
}
