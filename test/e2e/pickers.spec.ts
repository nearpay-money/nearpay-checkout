/**
 * "Pay with" dropdowns (network + token), wallet balances in the token list and the network-fee
 * pre-check before a wallet is asked to sign.
 */
import type { Page } from "@playwright/test";
import { USDC_BASE } from "../support/sessions";
import { a11yBasics } from "./support/a11y";
import { expect, test } from "./support/fixtures";
import { BASE_OPTIONS, ETH_BASE, hex, MANY, omft, RICH, USDT } from "./support/options";
import { choose, chooseNetwork } from "./support/pay";
import { injectEvmWallet, injectNearWallet, stubNearRpc } from "./support/wallets";

async function evmCalls(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { __evmCalls: { method: string }[] }).__evmCalls.map((c) => c.method),
  );
}

async function connectEvm(page: Page, url: string) {
  await page.goto(url);
  await page.getByTestId("path-wallet").click();
  await page.getByTestId("evm-wallet-test.mockwallet").click();
  await expect(page.getByTestId("asset-picker")).toBeVisible();
}

test("network dropdown: scrolls inside, type-to-filter, arrows + Enter, Esc returns focus, click outside", async ({
  page,
  mock,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const s = mock.create({}, { options: MANY });
  await page.goto(mock.url(s));
  await page.getByTestId("path-manual").click();
  // The best route is preselected: Base · USDC.
  await expect(page.getByTestId("network-picker-trigger")).toContainText("Base");
  await expect(page.getByTestId("token-picker-trigger")).toContainText("USDC");

  await page.getByTestId("network-picker-trigger").click();
  const list = page.getByTestId("network-picker-list");
  await expect(list).toBeVisible();
  await expect(page.getByTestId("network-picker-search")).toBeFocused();
  // Group headings once there are many networks, popular first.
  await expect(list.getByText("Popular")).toBeVisible();
  const box = await list.evaluate((el) => ({
    overflow: getComputedStyle(el).overflowY,
    max: getComputedStyle(el).maxHeight,
    scrolls: el.scrollHeight > el.clientHeight,
  }));
  expect(box).toEqual({ overflow: "auto", max: "320px", scrolls: true });
  // The page itself does not grow into a long list.
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);

  // Click outside closes without changing the selection.
  await page.mouse.click(5, 5);
  await expect(list).toHaveCount(0);

  // Type on the trigger: opens filtered; arrows + Enter pick; focus returns to the trigger.
  await page.getByTestId("network-picker-trigger").focus();
  await page.keyboard.press("p");
  await expect(page.getByTestId("network-picker-search")).toHaveValue("p");
  await page.keyboard.type("oly");
  await expect(list.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(list).toHaveCount(0);
  await expect(page.getByTestId("network-picker-trigger")).toBeFocused();
  await expect(page.getByTestId("network-picker-trigger")).toContainText("Polygon");

  // Esc clears the search first, then closes and returns focus.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("zzz");
  await expect(page.getByTestId("network-picker-empty")).toHaveText("No matching networks");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("network-picker-search")).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(page.getByTestId("network-picker-trigger")).toBeFocused();

  // Token dropdown: the chosen network's tokens only; search with no match.
  await chooseNetwork(page, "eip155:8453");
  await page.getByTestId("token-picker-trigger").click();
  await expect(page.getByTestId("token-picker-list").getByRole("option")).toHaveCount(4);
  await page.keyboard.type("doge");
  await expect(page.getByTestId("token-picker-empty")).toHaveText("No matching tokens");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await a11yBasics(page);
});

test("phones: the dropdown is a bottom sheet with a scrolling list", async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" }); // measure the sheet at rest, not mid-animation
  const s = mock.create({}, { options: MANY });
  await page.goto(mock.url(s));
  await page.getByTestId("path-manual").click();
  await page.getByTestId("network-picker-trigger").click();
  const panel = page.getByTestId("network-picker-panel");
  await expect(panel).toBeVisible();
  const sheet = await panel.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { position: getComputedStyle(el).position, bottom: Math.round(r.bottom), left: Math.round(r.left) };
  });
  expect(sheet).toEqual({ position: "fixed", bottom: 844, left: 0 });
  const list = page.getByTestId("network-picker-list");
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight && el.clientHeight <= 844 * 0.6 + 1)).toBe(true);
  await page.getByRole("button", { name: "Close list" }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId("network-picker-trigger")).toBeFocused();
});

test("EVM wallet: only tokens it holds, with balances, by value; Not enough; Show all tokens", async ({
  page,
  mock,
}) => {
  await injectEvmWallet(page, { chainId: "0x2105", reads: RICH });
  const s = mock.create({ livemode: true }, { options: BASE_OPTIONS });
  await connectEvm(page, mock.url(s));
  await expect(page.getByTestId("token-picker-trigger")).toContainText("USDC");
  await expect(page.getByTestId("token-picker-trigger")).toContainText("Balance 12.34");
  await page.getByTestId("token-picker-trigger").click();
  const rows = page.getByTestId("token-picker-list").getByRole("option");
  // USDT (0) is hidden; USDC (6× the payment) before ETH (1.7×); DAI doesn't cover it.
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("USDC · 12.34");
  await expect(rows.nth(1)).toContainText("ETH · 0.001");
  await expect(rows.nth(2)).toContainText("DAI · 1.50");
  await expect(rows.nth(2)).toContainText("Not enough");
  await expect(rows.nth(2)).toHaveAttribute("aria-disabled", "true");
  await page.getByTestId("show-all-tokens").click();
  await expect(rows).toHaveCount(4);
  await expect(page.getByTestId(`option-route_quote-${omft(USDT)}`)).toContainText("USDT · 0.00");
  await page.getByTestId("show-all-tokens").click();
  await expect(rows).toHaveCount(3);
  await page.keyboard.press("Escape");
  // Reads went through the wallet's provider only.
  const calls = await evmCalls(page);
  expect(calls.filter((m) => m === "eth_call")).toHaveLength(3);
  expect(calls).toContain("eth_getBalance");
});

test("EVM wallet on another chain: switch to read balances; read errors fall back to the full list", async ({
  page,
  mock,
}) => {
  await injectEvmWallet(page, { chainId: "0x1", reads: RICH });
  const s = mock.create({ livemode: true }, { options: BASE_OPTIONS });
  await connectEvm(page, mock.url(s));
  await expect(page.getByTestId("balances-wrong-chain")).toContainText("Switch it to Base");
  await page.getByTestId("switch-chain").click();
  await expect(page.getByTestId("balances-wrong-chain")).toHaveCount(0);
  await expect(page.getByTestId("token-picker-trigger")).toContainText("Balance 12.34");

  const page2 = await page.context().newPage();
  await injectEvmWallet(page2, { chainId: "0x2105" }); // no read support → errors
  await connectEvm(page2, mock.url(mock.create({ livemode: true }, { options: BASE_OPTIONS })));
  await expect(page2.getByTestId("balances-error")).toHaveText(
    "We couldn't load your balances, so all tokens are shown.",
  );
  await page2.getByTestId("token-picker-trigger").click();
  await expect(page2.getByTestId("token-picker-list").getByRole("option")).toHaveCount(4);
});

test("no ETH for gas: warning before signing, the wallet never opens; deposit-address path keeps the token", async ({
  page,
  mock,
}) => {
  await injectEvmWallet(page, { chainId: "0x2105", reads: { ...RICH, native: "0x0" } });
  const s = mock.create({ livemode: true }, { options: BASE_OPTIONS });
  await connectEvm(page, mock.url(s));
  await choose(page, "route_quote", USDC_BASE);
  const warning = page.getByTestId("gas-warning");
  await expect(warning).toContainText("Not enough ETH for the network fee");
  // 65000 × 1.2 × (2 × 0.005 gwei) + 1 gwei L1 fee = 0.00000078 + 0.000000001 → "about 0.00000079 ETH".
  await expect(warning).toContainText("You need about 0.00000079 ETH on Base to pay the network fee.");
  await expect(page.getByTestId("wallet-send")).toHaveCount(0);
  expect(await evmCalls(page)).not.toContain("eth_sendTransaction");

  await page.getByTestId("gas-manual").click();
  await expect(page.getByTestId("asset-picker")).toBeVisible();
  await expect(page.getByTestId("network-picker-trigger")).toContainText("Base");
  await expect(page.getByTestId("token-picker-trigger")).toContainText("USDC");
  await page.getByTestId("asset-continue").click();
  await expect(page.getByTestId("refund-form")).toBeVisible();
});

test("gas pre-check at Pay after the chain switch; paying ETH reserves the fee on top", async ({ page, mock }) => {
  // On Ethereum: the review can't check (no prompt), Pay switches to Base, then checks — and stops.
  await injectEvmWallet(page, {
    chainId: "0x1",
    reads: { ...RICH, native: hex(600_000_000_000_000n) }, // exactly the payment, nothing for the fee
  });
  const s = mock.create(
    { livemode: true },
    { options: BASE_OPTIONS, attestToken: null, attestMeta: { symbol: "ETH", decimals: 18 } },
  );
  await connectEvm(page, mock.url(s));
  await expect(page.getByTestId("balances-wrong-chain")).toBeVisible();
  await choose(page, "route_quote", ETH_BASE);
  await expect(page.getByTestId("wallet-send")).toBeVisible();
  expect(await evmCalls(page)).not.toContain("eth_estimateGas");
  await page.getByTestId("wallet-send").click();
  await expect(page.getByTestId("gas-warning")).toContainText("on top of the payment");
  expect(await evmCalls(page)).toContain("wallet_switchEthereumChain");
  expect(await evmCalls(page)).not.toContain("eth_sendTransaction");
  await page.getByTestId("gas-change").click();
  await expect(page.getByTestId("asset-picker")).toBeVisible();
});

test("enough ETH: the pre-check passes and the wallet is asked to send", async ({ page, mock }) => {
  await injectEvmWallet(page, { chainId: "0x1", reads: RICH });
  const s = mock.create({ livemode: true }, { options: BASE_OPTIONS, autoSucceed: true });
  await connectEvm(page, mock.url(s));
  await choose(page, "route_quote", USDC_BASE);
  await page.getByTestId("wallet-send").click();
  await expect(page.getByTestId("succeeded")).toBeVisible();
  const calls = await evmCalls(page);
  const send = calls.indexOf("eth_sendTransaction");
  expect(calls.indexOf("wallet_switchEthereumChain")).toBeLessThan(calls.lastIndexOf("eth_estimateGas"));
  expect(calls.lastIndexOf("eth_estimateGas")).toBeLessThan(send);
});

test("NEAR wallet without NEAR for gas: warning, nothing signed", async ({ page, mock }) => {
  await injectNearWallet(page);
  await stubNearRpc(page, false, { native: "0" });
  const s = mock.create({ livemode: true });
  await page.goto(mock.url(s));
  await page.getByTestId("path-wallet").click();
  await page.getByTestId("near-connect").click();
  await expect(page.getByTestId("token-picker-trigger")).toContainText("Balance 1,000,000");
  await page.getByTestId("asset-continue").click();
  await expect(page.getByTestId("gas-warning")).toContainText("You need about");
  await expect(page.getByTestId("gas-warning")).toContainText("NEAR on NEAR");
  const signed = await page.evaluate(() => (window as unknown as { __nearCalls: unknown[] }).__nearCalls.length);
  expect(signed).toBe(0);
});
