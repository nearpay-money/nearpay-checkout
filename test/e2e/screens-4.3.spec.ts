/**
 * Screenshot tour of the step 4.3 screens at 1440 and 390 px: Solana wallets (§11) and hosted invoice
 * auto-pay (§4.4). Runs only with NP_SHOTS=<dir>
 * (`NP_SHOTS=/home/claude/shots/checkout-4.3 pnpm exec playwright test screens-4.3`).
 */

import { SOLANA_MAINNET } from "@nearpay/spec";
import v from "@nearpay/spec/test-vectors/solana-transfer.json" with { type: "json" };
import type { Page } from "@playwright/test";
import { mandate, withdrawTx } from "../support/mandates";
import { expect, test } from "./support/fixtures";
import type { MockNearPay } from "./support/mock-server";
import { choose } from "./support/pay";
import { injectNearWallet, injectSolanaWallet, SOL_PAYER, stubSolanaRpc } from "./support/wallets";

const DIR = process.env.NP_SHOTS ?? "";
test.skip(!DIR, "screenshots only with NP_SHOTS");
test.describe.configure({ mode: "serial" });

const WIDTHS = [
  [1440, 900],
  [390, 844],
] as const;
const BTC = "bip122:000000000019d6689c085ae165831e93";
const SPL = v.spl.asset_id;
const option = (asset: string, chain: string, symbol: string, decimals: number, amount: string) => ({
  method: "route_quote",
  origin_asset_id: asset,
  chain,
  symbol,
  decimals,
  estimated_amount_in: amount,
  route_class: "stable_pair",
  min_deadline_s: 300,
  available: true,
  reason: null,
});
const OPTIONS = [
  option(SPL, SOLANA_MAINNET, "USDC", 6, v.spl.amount_in),
  option(v.sol.asset_id, SOLANA_MAINNET, "SOL", 9, v.sol.amount_in),
  option("nep141:btc.omft.near", BTC, "BTC", 8, "123450"),
];
const SPL_TOKEN = { standard: "spl", address: v.spl.mint };
const MD = "md_01jbz9k3m4n5p6q7r8s9t0v1w2" as const;

async function shot(page: Page, name: string) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${DIR}/${name}-${page.viewportSize()?.width}.png`, fullPage: true });
}

async function solWallet(page: Page, mock: MockNearPay, opts: Parameters<typeof injectSolanaWallet>[1] = {}) {
  await injectSolanaWallet(page, opts);
  await stubSolanaRpc(page);
  const s = mock.create({ livemode: true }, { options: OPTIONS, attestToken: SPL_TOKEN, autoSucceed: false });
  await page.goto(mock.url(s));
  await page.getByTestId("path-wallet").click();
}

for (const [w, h] of WIDTHS) {
  test.describe(`${w}px`, () => {
    test.beforeEach(async ({ page }) => page.setViewportSize({ width: w, height: h }));

    test("solana screens", async ({ page, mock }) => {
      await solWallet(page, mock);
      await expect(page.getByTestId("sol-wallet-mock-phantom")).toBeVisible();
      await shot(page, "01-connect-wallet-solana");
      await page.getByTestId("sol-wallet-mock-phantom").click();
      await choose(page, "route_quote", SPL);
      await expect(page.getByTestId("network-fee-note")).toContainText("rent");
      await shot(page, "02-review-spl-rent");

      const p2 = await page.context().newPage();
      await p2.setViewportSize({ width: w, height: h });
      const { stubExternal } = await import("./support/fixtures");
      await stubExternal(p2);
      await solWallet(p2, mock, { sendError: "Transaction simulation failed: blockhash not found" });
      await p2.getByTestId("sol-wallet-mock-phantom").click();
      await choose(p2, "route_quote", SPL);
      await p2.getByTestId("wallet-send").click();
      await expect(p2.getByTestId("wallet-pay")).toContainText("Transaction failed in your wallet");
      await shot(p2, "03-tx-failed");
      await p2.close();

      const p3 = await page.context().newPage();
      await p3.setViewportSize({ width: w, height: h });
      await stubExternal(p3);
      await injectSolanaWallet(p3);
      await stubSolanaRpc(p3, { token2022: true });
      const s3 = mock.create({ livemode: true }, { options: OPTIONS, attestToken: SPL_TOKEN });
      await p3.goto(mock.url(s3));
      await p3.getByTestId("path-wallet").click();
      await p3.getByTestId("sol-wallet-mock-phantom").click();
      await choose(p3, "route_quote", SPL);
      await expect(p3.getByTestId("solana-manual-only")).toBeVisible();
      await shot(p3, "04-solana-manual-only");
      await p3.close();
    });

    test("manual solana pay + bitcoin qr", async ({ page, mock }) => {
      const s = mock.create({ livemode: true }, { options: OPTIONS, attestToken: SPL_TOKEN, autoSucceed: false });
      await page.goto(mock.url(s));
      await page.getByTestId("path-manual").click();
      await choose(page, "route_quote", SPL);
      await page.getByTestId("refund-address").fill(SOL_PAYER);
      await page.getByTestId("continue").click();
      await page.getByTestId("confirm-network").check();
      await expect(page.getByTestId("qr")).toBeVisible();
      await shot(page, "05-manual-solana-pay");

      const b = mock.create(
        { livemode: true },
        {
          options: OPTIONS,
          attestToken: { standard: "native", address: null },
          attestMeta: { symbol: "BTC", decimals: 8 },
          autoSucceed: false,
        },
      );
      await page.goto(mock.url(b));
      await page.getByTestId("path-manual").click();
      await choose(page, "route_quote", "nep141:btc.omft.near");
      await page.getByTestId("refund-address").fill("bc1pzkakv8d86xwnrvzx262umfvz04dxjeegc4lez8aqdlx50zjfsr5qrjf5pr");
      await page.getByTestId("continue").click();
      await page.getByTestId("confirm-network").check();
      await expect(page.getByTestId("qr")).toBeVisible();
      await shot(page, "06-manual-bitcoin");
    });

    test("auto-pay screens", async ({ page, mock }) => {
      await injectNearWallet(page);
      const m = mock.createInvoice({
        livemode: true,
        auto_debit: { available: true, mandate: null, collecting: false },
      });
      await page.goto(mock.invoiceUrl(m));
      await expect(page.getByTestId("autopay-entry")).toBeVisible();
      await shot(page, "10-invoice-autopay-offer");
      await page.getByTestId("autopay-setup").click();
      await expect(page.getByTestId("autopay-terms")).toBeVisible();
      await page.getByTestId("autopay-own-account").check();
      await shot(page, "11-autopay-terms");
      await page.getByTestId("autopay-approve").click();
      await expect(page.getByTestId("autopay-waiting")).toBeVisible();
      await shot(page, "12-autopay-waiting");
      m.invoice.auto_debit = { available: false, mandate: MD, collecting: true };
      m.mandate = mandate({ balance: "30000000", funded_periods: 3, collected_periods: 0 });
      await expect(page.getByTestId("autopay-manage-view")).toBeVisible({ timeout: 10_000 });
      await shot(page, "13-autopay-manage-active");
      await page.getByTestId("autopay-cancel").click();
      await expect(page.getByTestId("autopay-cancel-dialog")).toBeVisible();
      await shot(page, "14-autopay-cancel-dialog");
      await page.keyboard.press("Escape");
      await page.getByTestId("autopay-back").click();
      await expect(page.getByTestId("autopay-collecting")).toBeVisible();
      await shot(page, "15-invoice-autopay-collecting");

      m.mandate = mandate({ status: "insufficient", balance: "4000000", funded_periods: 0 });
      await page.getByTestId("autopay-manage").click();
      await expect(page.getByTestId("autopay-low")).toBeVisible();
      await shot(page, "16-autopay-low-balance");

      m.mandate = mandate({
        status: "canceled",
        collecting: false,
        top_up_msg: null,
        transactions: { cancel: null, withdraw: withdrawTx },
      });
      await page.getByTestId("autopay-back").click();
      await page.getByTestId("autopay-manage").click();
      await expect(page.getByTestId("autopay-withdrawable")).toBeVisible();
      await shot(page, "17-autopay-withdraw");

      const t = mock.createInvoice({
        livemode: false,
        auto_debit: { available: true, mandate: null, collecting: false },
      });
      await page.goto(mock.invoiceUrl(t));
      await page.getByTestId("autopay-setup").click();
      await expect(page.getByTestId("autopay-test-note")).toBeVisible();
      await shot(page, "18-autopay-test-mode");
    });
  });
}
