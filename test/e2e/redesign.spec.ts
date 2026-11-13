/** Step 2.3: redesigned flows (review, change, wallet errors, re-quote), payment links, a11y basics. */
import type { Page } from "@playwright/test";
import { USDC_BASE } from "../support/sessions";
import { a11yBasics } from "./support/a11y";
import { expect, test } from "./support/fixtures";
import type { MockLink, MockNearPay, MockSession } from "./support/mock-server";
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

/** Pays a link's session on the manual path in test mode ("Simulate payment") up to "Payment complete". */
async function payLink(page: Page, mock: MockNearPay, l: MockLink): Promise<MockSession> {
  await page.goto(`${mock.origin}/l/${l.link.id}`);
  await page.getByTestId("link-continue").click();
  await page.getByTestId("path-manual").click();
  await choose(page, "route_quote", USDC_BASE);
  await page.getByTestId("refund-address").fill("0x52908400098527886E0F7030069857D2E4169EE7");
  await page.getByTestId("continue").click();
  await page.getByTestId("simulate").click();
  await expect(page.getByTestId("succeeded")).toBeVisible();
  const s = l.sessions[0];
  if (!s) throw new Error("no session");
  return s;
}

/** Screenshots for visual review, only with NP_SHOTS=<dir>. */
async function shot(page: Page, name: string) {
  if (process.env.NP_SHOTS) await page.screenshot({ path: `${process.env.NP_SHOTS}/${name}.png`, fullPage: true });
}

test("payment link without a merchant redirect: Payment complete is the final screen", async ({ page, mock }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const l = mock.createLink({}, { sessionOpts: { autoSucceed: true } });
  const s = await payLink(page, mock, l);
  // As payments does for a link without `success_url`: the checkout's own confirmation URL.
  expect(s.session.success_url).toBe(`${mock.origin}/l/${l.link.id}/complete`);
  const navigations: string[] = [];
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) navigations.push(f.url());
  });
  const done = page.getByTestId("succeeded");
  await expect(done).toContainText("Payment complete");
  await expect(done).toContainText("Acme GmbH has received your payment.");
  await expect(done).toContainText("You can close this page.");
  // Nowhere to return to: no button, no "Returning you…", and the checkout's host is not shown as the merchant's site.
  await expect(page.getByTestId("continue-merchant")).toHaveCount(0);
  await expect(page.getByText(/Return to|Returning you/)).toHaveCount(0);
  await expect(page.locator(".np-checkout__merchant-name")).toHaveText("Acme GmbH");
  await expect(page.locator(".np-checkout__merchant-sub")).toHaveCount(0);
  // The redirect used to fire 2.5 s after success and end on "This checkout can't be used".
  await page.waitForTimeout(5000);
  expect(navigations).toEqual([]);
  expect(new URL(page.url()).pathname).toBe(`/c/${s.session.id}`);
  await expect(done).toBeVisible();
  await expect(page.getByTestId("blocked")).toHaveCount(0);
  await a11yBasics(page);
  await shot(page, "link-no-redirect-complete");
  // A reload resumes the completed session and stays there too.
  await page.reload();
  await expect(page.getByTestId("succeeded")).toContainText("You can close this page.");
  await expect(page.getByTestId("continue-merchant")).toHaveCount(0);
  await page.waitForTimeout(3000);
  expect(new URL(page.url()).pathname).toBe(`/c/${s.session.id}`);
});

test("a link's confirmation URL opened directly: a calm page that claims nothing, not an error", async ({
  page,
  mock,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const l = mock.createLink();
  // Where sessions opened before the fix were sent: no client secret, only the session id.
  await page.goto(`${mock.origin}/l/${l.link.id}/complete?session_id=cs_01jbz9k3m4n5p6q7r8s9t0v1w2`);
  const done = page.getByTestId("link-complete");
  await expect(done).toBeVisible();
  await expect(done.getByRole("heading")).toHaveText("You can close this page");
  await expect(done).toContainText("If you just paid here, the merchant has received your payment.");
  await expect(done).toContainText("not a receipt");
  await expect(page.getByTestId("blocked")).toHaveCount(0);
  // Anyone can open this URL: no "Paid" state, no amount, no merchant, and nothing is read from the API.
  await expect(page.getByText("Paid", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Payment complete")).toHaveCount(0);
  await expect(page.getByText(/\$|USDC|Acme/)).toHaveCount(0);
  expect(mock.calls).toEqual([]);
  await a11yBasics(page);
  await shot(page, "link-complete-direct");
  // Unknown but well-formed link ids get the same page (nothing is looked up); with a trailing slash too.
  await page.goto(`${mock.origin}/l/plink_01jbz9k3m4n5p6q7r8s9t0v1zz/complete/`);
  await expect(page.getByTestId("link-complete")).toBeVisible();
  // A malformed id keeps the error page, and so does /complete under any other route.
  await page.goto(`${mock.origin}/l/plink_123/complete?session_id=cs_01jbz9k3m4n5p6q7r8s9t0v1w2`);
  await expect(page.getByTestId("blocked-invalid_link")).toBeVisible();
  await expect(page.getByTestId("link-complete")).toHaveCount(0);
  await page.goto(`${mock.origin}/c/cs_01jbz9k3m4n5p6q7r8s9t0v1w2/complete`);
  await expect(page.getByTestId("blocked-invalid_link")).toBeVisible();
});

test("payment link with a merchant redirect still returns to the merchant", async ({ page, mock }) => {
  const l = mock.createLink({}, { successUrl: "https://shop.example/thanks", sessionOpts: { autoSucceed: true } });
  const s = await payLink(page, mock, l);
  await expect(page.getByTestId("continue-merchant")).toHaveText("Return to Acme GmbH");
  await expect(page.getByTestId("continue-merchant")).toHaveAttribute(
    "href",
    `https://shop.example/thanks?session_id=${s.session.id}`,
  );
  await expect(page.getByTestId("succeeded")).toContainText("Returning you to the merchant…");
  await expect(page.getByTestId("succeeded")).not.toContainText("You can close this page.");
  await page.waitForURL(`https://shop.example/thanks?session_id=${s.session.id}`);
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

test("system dark mode keeps the light design by default; desktop two-column review", async ({ page, mock }) => {
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
  // Light by default even when the payer's system is dark (owner, 2026-11-13): no dark canvas, light colour scheme.
  const look = () =>
    page.evaluate(() => ({
      scheme: getComputedStyle(document.documentElement).colorScheme,
      html: getComputedStyle(document.documentElement).backgroundColor,
      covers: document.documentElement.getBoundingClientRect().height >= window.innerHeight,
    }));
  const desk = await look();
  expect(desk.scheme).toBe("light");
  expect(desk.html).not.toBe("rgb(11, 26, 44)");
  expect(desk.covers).toBe(true);
  await page.setViewportSize({ width: 390, height: 1400 });
  const phone = await look();
  expect(phone.scheme).toBe("light");
  expect(phone.html).not.toBe("rgb(18, 38, 63)");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId("use-manual").click();
  await expect(page.getByTestId("asset-picker")).toBeVisible();
});
