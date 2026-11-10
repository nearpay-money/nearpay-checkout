/** Step 2.3: redesigned flows (review, change, wallet errors, re-quote), payment links, a11y basics. */
import type { Page } from "@playwright/test";
import { USDC_BASE } from "../support/sessions";
import { a11yBasics } from "./support/a11y";
import { expect, test } from "./support/fixtures";
import { choose } from "./support/pay";
import { injectEvmWallet } from "./support/wallets";

async function toReview(page: Page) {
  await page.getByTestId("path-wallet").click();
  await page.getByTestId("evm-wallet-test.mockwallet").click();
  await choose(page, "route_quote", USDC_BASE);
  await expect(page.getByTestId("wallet-send")).toBeVisible();
}

test("wallet review: attested totals, fee note, quote countdown, change", async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await injectEvmWallet(page, { chainId: "0x2105" });
  const s = mock.create({ livemode: true });
  await page.goto(mock.url(s));
  await expect(page.getByTestId("choose-path")).toBeVisible();
  await a11yBasics(page);
  await toReview(page);
  await expect(page.getByTestId("purchase")).toHaveText("$2.00");
  await expect(page.getByTestId("total-to-send")).toHaveText("2.005013 USDC");
  await expect(page.getByTestId("wallet-pay")).toContainText("Your wallet may charge a separate network fee.");
  await expect(page.getByTestId("wallet-pay")).toContainText("Included in total");
  await expect(page.getByTestId("countdown")).toContainText(/Price held for 1[45]:\d\d/);
  await expect(page.getByTestId("wallet-send")).toHaveText("Pay 2.005013 USDC");
  await expect(page.getByTestId("verified-merchant")).toContainText("Payout address verified for Acme GmbH");
  await expect(page.getByTestId("verified-merchant")).toContainText("Business details declared by the merchant");
  // Phones: the order summary is a header with an "Order details" disclosure; the pay side keeps the cards.
  await expect(page.getByTestId("order-header")).toContainText("Acme GmbH");
  await expect(page.getByTestId("order-details")).not.toHaveAttribute("open", "");
  await expect(page.getByTestId("change-network")).toContainText("Base");
  await expect(page.getByTestId("change-option")).toContainText("USDC");
  await expect(page.getByTestId("review-wallet")).toContainText("connected");
  await expect(page.getByTestId("use-manual")).toHaveText("Pay from another wallet or exchange");
  await a11yBasics(page);
  await page.getByTestId("change-option").click();
  await expect(page.getByTestId("asset-picker")).toBeVisible();
  await choose(page, "route_quote", USDC_BASE);
  await expect(page.getByTestId("wallet-send")).toBeVisible();
  expect(mock.callsTo("createPaymentAttempt")).toHaveLength(2);
});

test("wallet errors: not approved, then not enough funds", async ({ page, mock }) => {
  await injectEvmWallet(page, { chainId: "0x2105", sendError: "reject" });
  const s = mock.create({ livemode: true });
  await page.goto(mock.url(s));
  await toReview(page);
  await page.getByTestId("wallet-send").click();
  await expect(page.getByTestId("wallet-pay")).toContainText("Payment not approved");
  await expect(page.getByTestId("wallet-pay")).toContainText("Not submitted");
  expect(mock.callsTo("submitDepositTx")).toHaveLength(0);
  await page.getByTestId("try-again").click();
  await expect(page.getByTestId("wallet-send")).toBeVisible();
});

test("not enough funds offers another currency", async ({ page, mock }) => {
  await injectEvmWallet(page, { chainId: "0x2105", sendError: "insufficient" });
  const s = mock.create({ livemode: true });
  await page.goto(mock.url(s));
  await toReview(page);
  await page.getByTestId("wallet-send").click();
  await expect(page.getByTestId("wallet-pay")).toContainText("Not enough funds");
  await expect(page.getByTestId("wallet-pay")).toContainText("2.005013 USDC needed");
  await page.getByTestId("choose-another").click();
  await expect(page.getByTestId("asset-picker")).toBeVisible();
});

test("an expired wallet quote asks for a new one and shows the updated total", async ({ page, mock }) => {
  await injectEvmWallet(page, { chainId: "0x2105" });
  const s = mock.create({ livemode: true }, { deadlineS: 3 });
  await page.goto(mock.url(s));
  await toReview(page);
  await expect(page.getByTestId("quote-expired")).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId("wallet-send")).toHaveCount(0);
  s.deadlineS = 900;
  (s.options[0] as { estimated_amount_in: string }).estimated_amount_in = "2006000";
  await page.getByTestId("new-address").click();
  await expect(page.getByText("Review your updated total")).toBeVisible();
  await expect(page.getByTestId("total-to-send")).toHaveText("2.006 USDC");
  await expect(page.getByTestId("wallet-pay")).toContainText("2.005013 USDC");
});

test("a wrongly attested asset is a verification failure", async ({ page, mock }) => {
  const s = mock.create({}, { attestAsset: "wrong" });
  await page.goto(mock.url(s));
  await page.getByTestId("path-manual").click();
  await choose(page, "route_quote", USDC_BASE);
  await page.getByTestId("refund-address").fill("0x52908400098527886E0F7030069857D2E4169EE7");
  await page.getByTestId("continue").click();
  await expect(page.getByTestId("verify-failed")).toBeVisible();
  await expect(page.getByTestId("verify-reason")).toContainText("asset");
  expect(await page.content()).not.toContain("0x76b4c56085ed136a8744d52be956396624a730e8");
});

test("payment link: shows the link, opens a session, continues in the normal flow", async ({ page, mock }) => {
  const l = mock.createLink({ collect_email: true }, { sessionOpts: { autoSucceed: true } });
  await page.goto(`${mock.origin}/l/${l.link.id}`);
  await expect(page.getByText("Pro plan").first()).toBeVisible();
  await expect(page.getByTestId("price")).toHaveText("$49.00");
  await expect(page.getByTestId("test-banner")).toBeVisible();
  await expect(page.getByText("Acme (unverified)")).toHaveCount(0);
  await a11yBasics(page);
  await page.getByTestId("link-continue").click();
  await expect(page.getByText("Enter a valid email address.")).toBeVisible();
  await page.getByTestId("link-email").fill("payer@example.com");
  await page.getByTestId("link-continue").click();
  await expect(page.getByTestId("choose-path")).toBeVisible();
  const s = l.sessions[0];
  if (!s) throw new Error("no session");
  expect(mock.bodyOf("createPaymentLinkSession")).toEqual({ customer_email: "payer@example.com" });
  expect(new URL(page.url()).pathname).toBe(`/c/${s.session.id}`);
  expect(new URL(page.url()).hash).toBe(`#${s.secret}`);
  expect(mock.callsTo("getPublicCheckoutSession")[0]?.headers["x-nearpay-client-secret"]).toBe(s.secret);
  await page.getByTestId("path-manual").click();
  await choose(page, "route_quote", USDC_BASE);
  await page.getByTestId("refund-address").fill("0x52908400098527886E0F7030069857D2E4169EE7");
  await page.getByTestId("continue").click();
  await page.getByTestId("simulate").click();
  await expect(page.getByTestId("succeeded")).toBeVisible();
});

test("payment link: inactive, not found, and link_inactive on open", async ({ page, mock }) => {
  const off = mock.createLink({ active: false });
  await page.goto(`${mock.origin}/l/${off.link.id}`);
  await expect(page.getByTestId("link-inactive")).toContainText("no longer active");
  await page.goto(`${mock.origin}/l/plink_01jbz9k3m4n5p6q7r8s9t0v1zz`);
  await expect(page.getByTestId("link-not-found")).toBeVisible();
  const racing = mock.createLink({}, { sessionError: "link_inactive" });
  await page.goto(`${mock.origin}/l/${racing.link.id}`);
  await page.getByTestId("link-continue").click();
  await expect(page.getByTestId("link-inactive")).toBeVisible();
  const notLive = mock.createLink({}, { sessionError: "account_not_live" });
  await page.goto(`${mock.origin}/l/${notLive.link.id}`);
  await page.getByTestId("link-continue").click();
  await expect(page.getByTestId("error")).toContainText("can't accept live payments yet");
});

test("dark theme and desktop two-column review", async ({ page, mock }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await injectEvmWallet(page, { chainId: "0x2105" });
  const s = mock.create({ livemode: true });
  await page.goto(mock.url(s));
  await toReview(page);
  await expect(page.locator(".np-checkout--with-summary")).toBeVisible();
  await expect(page.getByTestId("use-manual")).toBeVisible();
  // Desktop split: the navy order side carries "You send" and the route; the fee card leaves "You send" out.
  await expect(page.locator(".np-checkout__summary.np-surface-navy")).toContainText("How your payment travels");
  await expect(page.locator(".np-checkout__summary")).toContainText("USDC on Base");
  await expect(page.locator(".np-checkout__summary")).toContainText("Acme GmbH's wallet");
  await expect(page.getByTestId("total-to-send")).toHaveText("2.005013 USDC");
  await expect(page.getByTestId("fee-card")).not.toContainText("You send");
  await expect(page.getByTestId("order-header")).toHaveCount(0);
  // The theme background covers the whole viewport: desktop canvas (#0b1a2c) on html and body…
  const bgs = () =>
    page.evaluate(() => ({
      html: getComputedStyle(document.documentElement).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
      bottom: document.elementFromPoint(5, window.innerHeight - 2)?.closest("html") !== null,
      covers: document.documentElement.getBoundingClientRect().height >= window.innerHeight,
    }));
  expect(await bgs()).toEqual({ html: "rgb(11, 26, 44)", body: "rgb(11, 26, 44)", bottom: true, covers: true });
  // …and the dark surface (#12263f) on phones.
  await page.setViewportSize({ width: 390, height: 1400 });
  expect(await bgs()).toMatchObject({ html: "rgb(18, 38, 63)", body: "rgb(18, 38, 63)", covers: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId("use-manual").click();
  await expect(page.getByTestId("asset-picker")).toBeVisible();
});
