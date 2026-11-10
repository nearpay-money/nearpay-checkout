/** Pending checkout CRs adopted from spec 0.2.1/0.3.0: payer fee, amount received, pricing asset, attested token. */
import type { Page } from "@playwright/test";
import { USDC_BASE, USDC_NEAR } from "../support/sessions";
import { expect, test } from "./support/fixtures";
import type { MockNearPay, MockSession } from "./support/mock-server";
import { choose } from "./support/pay";
import { injectEvmWallet } from "./support/wallets";

const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

async function toReview(page: Page, mock: MockNearPay, s: MockSession) {
  await page.goto(mock.url(s));
  await page.getByTestId("path-wallet").click();
  await page.getByTestId("evm-wallet-test.mockwallet").click();
  await choose(page, "route_quote", USDC_BASE);
  await expect(page.getByTestId("wallet-send")).toBeVisible();
}

for (const [fee, shown] of [
  ["5013", "0.005013 USDC"],
  ["0", "None"],
] as const) {
  test(`route-quote payer fee from DepositInstructions.fee_amount (${fee})`, async ({ page, mock }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await injectEvmWallet(page, { chainId: "0x2105" });
    const s = mock.create({ livemode: true }, { feeAmount: fee });
    await toReview(page, mock, s);
    // Phones: the price and fee rows sit in the "Price and fees" disclosure.
    await page.getByText("Price and fees").click();
    await expect(page.getByTestId("payment-fees")).toBeVisible();
    await expect(page.getByTestId("payment-fees")).toHaveText(shown);
    await expect(page.getByTestId("total-to-send")).toHaveText("2.005013 USDC");
  });
}

test("older servers without fee_amount: Included in total", async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await injectEvmWallet(page, { chainId: "0x2105" });
  const s = mock.create({ livemode: true });
  await toReview(page, mock, s);
  await expect(page.getByTestId("payment-fees")).toHaveCount(0);
  await expect(page.getByText("Included in total")).toBeHidden();
  await page.getByText("Price and fees").click();
  await expect(page.getByText("Included in total")).toBeVisible();
});

test("We received less than expected: Received and Still to send from amount_received", async ({ page, mock }) => {
  const s = mock.create();
  await page.goto(mock.url(s));
  await page.getByTestId("path-manual").click();
  await choose(page, "route_quote", USDC_BASE);
  await page.getByTestId("refund-address").fill("0x52908400098527886E0F7030069857D2E4169EE7");
  await page.getByTestId("continue").click();
  await expect(page.getByTestId("manual-instructions")).toBeVisible();
  mock.setAttempt(s, { status: "incomplete_deposit", amount_received: "1000000" });
  await expect(page.getByTestId("top-up")).toBeVisible();
  await expect(page.getByTestId("received")).toHaveText("1.00 USDC");
  await expect(page.getByTestId("remaining")).toHaveText("1.005013 USDC");
});

test("asset-priced payment link shows the pricing asset (pricing_asset)", async ({ page, mock }) => {
  const l = mock.createLink({
    currency: "asset",
    asset_id: USDC_NEAR,
    amount: "2500000",
    pricing_asset: { asset_id: USDC_NEAR, symbol: "USDC", decimals: 6 },
  });
  await page.goto(`${mock.origin}/l/${l.link.id}`);
  await expect(page.getByTestId("price")).toHaveText("2.50 USDC");
});

test("the signed Attestation.asset.token wins: a contradicting contract disables the wallet transfer", async ({
  page,
  mock,
}) => {
  await injectEvmWallet(page, { chainId: "0x2105" });
  const s = mock.create(
    { livemode: true },
    { attestToken: { standard: "erc20", address: "0x0000000000000000000000000000000000000bad" } },
  );
  await toReview(page, mock, s);
  await page.getByTestId("wallet-send").click();
  await expect(page.getByTestId("error")).toContainText("can't be paid from a wallet");
  const calls =
    (await page.evaluate(() => (window as unknown as { __evmCalls: { method: string }[] }).__evmCalls)) ?? [];
  expect(calls.map((c) => c.method)).not.toContain("eth_sendTransaction");
});

test("the signed Attestation.asset.token matching the asset pays that contract", async ({ page, mock }) => {
  await injectEvmWallet(page, { chainId: "0x2105" });
  const s = mock.create({ livemode: true }, { attestToken: { standard: "erc20", address: TOKEN }, autoSucceed: true });
  await toReview(page, mock, s);
  await page.getByTestId("wallet-send").click();
  await expect(page.getByTestId("succeeded")).toBeVisible();
  const calls =
    (await page.evaluate(
      () => (window as unknown as { __evmCalls: { method: string; params?: unknown[] }[] }).__evmCalls,
    )) ?? [];
  const tx = calls.find((c) => c.method === "eth_sendTransaction")?.params?.[0] as Record<string, string>;
  expect(tx.to).toBe(TOKEN);
});
