/**
 * Landing-page look screenshot tour at 1440 and 390 px (owner review against the nearpay-site showcase
 * checkout card): "Pay with" with the network and the token dropdown open, confirming, paid, manual send
 * and every option unavailable; then the other screens restyled with it (connect a wallet, review, refund
 * form, verification failed, expired session, dark review). Runs only with NP_SHOTS=<dir>
 * (`NP_SHOTS=/home/claude/shots/checkout-ui pnpm exec playwright test screens-landing`).
 */
import type { Page } from "@playwright/test";
import { USDC_BASE } from "../support/sessions";
import { expect, test } from "./support/fixtures";
import { BASE_OPTIONS, MANY, RICH } from "./support/options";
import { choose, openPicker } from "./support/pay";
import { injectEvmWallet } from "./support/wallets";

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
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${DIR}/${name}-${page.viewportSize()?.width}.png`, fullPage: true });
}

for (const [w, h] of WIDTHS) {
  test.describe(`${w}px`, () => {
    test.beforeEach(async ({ page }) => page.setViewportSize({ width: w, height: h }));

    test("pay with: network and token dropdowns", async ({ page, mock }) => {
      await injectEvmWallet(page, { chainId: "0x2105", reads: RICH });
      const s = mock.create(SITE, { options: MANY });
      await page.goto(mock.url(s));
      await page.getByTestId("path-wallet").click();
      await page.getByTestId("evm-wallet-test.mockwallet").click();
      await expect(page.getByTestId("token-picker-trigger")).toContainText("12.34");
      await shot(page, "01-pay-with");
      await openPicker(page, "network-picker");
      await shot(page, "02-network-open");
      await page.keyboard.press("Escape");
      await openPicker(page, "token-picker");
      await shot(page, "03-token-open");
    });

    test("all options unavailable", async ({ page, mock }) => {
      const s = mock.create(SITE, {
        options: BASE_OPTIONS.map((o) => ({ ...o, available: false, reason: "route_unavailable" })),
      });
      await page.goto(mock.url(s));
      await page.getByTestId("path-manual").click();
      await expect(page.getByTestId("all-unavailable")).toBeVisible();
      await shot(page, "04-all-unavailable");
    });

    test("manual send, confirming, paid", async ({ page, mock }) => {
      const s = mock.create({ success_url: "https://acme.example/thanks" }, { memo: null });
      await page.goto(mock.url(s));
      await page.getByTestId("path-manual").click();
      await choose(page, "route_quote", USDC_BASE);
      await page.getByTestId("refund-address").fill(REFUND);
      await page.getByTestId("continue").click();
      await expect(page.getByTestId("manual-instructions")).toBeVisible();
      await page.getByTestId("confirm-network").click();
      await expect(page.getByTestId("deposit-address")).toBeVisible();
      await shot(page, "05-manual-send");
      mock.setAttempt(s, { status: "deposit_detected", attestation_ticket: null });
      await expect(page.getByTestId("processing")).toBeVisible();
      await shot(page, "06-confirming");
      mock.succeed(s);
      await expect(page.getByTestId("succeeded")).toBeVisible();
      await shot(page, "07-paid");
    });
    test("connect a wallet, review, refund form, errors, dark", async ({ page, mock }) => {
      await injectEvmWallet(page, { chainId: "0x2105", reads: RICH });
      const s = mock.create(SITE, { options: BASE_OPTIONS });
      await page.goto(mock.url(s));
      await page.getByTestId("path-wallet").click();
      await expect(page.getByTestId("evm-wallet-test.mockwallet")).toBeVisible();
      await shot(page, "08-connect-wallet");
      await page.getByTestId("evm-wallet-test.mockwallet").click();
      await expect(page.getByTestId("token-picker-trigger")).toContainText("12.34");
      await choose(page, "route_quote", USDC_BASE);
      await expect(page.getByTestId("review-wallet")).toContainText("balance covers the network fee");
      await shot(page, "09-review");

      const m = mock.create(SITE, { options: BASE_OPTIONS });
      await page.goto(mock.url(m));
      await page.getByTestId("path-manual").click();
      await choose(page, "route_quote", USDC_BASE);
      await expect(page.getByTestId("refund-address")).toBeVisible();
      await shot(page, "10-refund-form");

      const f = mock.create({}, { sentinel: "tamper_address" });
      await page.goto(mock.url(f));
      await page.getByTestId("path-manual").click();
      await choose(page, "route_quote", USDC_BASE);
      await page.getByTestId("refund-address").fill(REFUND);
      await page.getByTestId("continue").click();
      await expect(page.getByTestId("verify-failed")).toBeVisible();
      await shot(page, "11-verify-failed");

      const expired = mock.create({ status: "expired", intent_status: "expired" });
      await page.goto(mock.url(expired));
      await expect(page.getByTestId("blocked-session_expired")).toBeVisible();
      await shot(page, "12-expired-session");

      await page.emulateMedia({ colorScheme: "dark" });
      const d = mock.create(SITE, { options: MANY });
      await page.goto(mock.url(d));
      await page.getByTestId("path-wallet").click();
      await page.getByTestId("evm-wallet-test.mockwallet").click();
      await expect(page.getByTestId("token-picker-trigger")).toContainText("12.34");
      await openPicker(page, "token-picker");
      await shot(page, "13-dark-pay-with");
    });
  });
}
