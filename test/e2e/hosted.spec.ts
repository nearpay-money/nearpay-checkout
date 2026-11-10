import type { Page } from "@playwright/test";
import { USDC_BASE, USDC_NEAR } from "../support/sessions";
import { expect, test } from "./support/fixtures";
import type { MockNearPay, MockSession } from "./support/mock-server";
import { choose } from "./support/pay";

async function manualToInstructions(page: Page, mock: MockNearPay, s: MockSession) {
  await page.goto(mock.url(s));
  await expect(page.getByTestId("price")).toHaveText("$2.00");
  await page.getByTestId("path-manual").click();
  await choose(page, "route_quote", USDC_BASE);
  await page.getByTestId("refund-address").fill("0x52908400098527886E0F7030069857D2E4169EE7");
  await page.getByTestId("continue").click();
  await expect(page.getByTestId("manual-instructions")).toBeVisible();
}

test("manual path in test mode: verified merchant, guarded address, simulate, success redirect", async ({
  page,
  mock,
}) => {
  const s = mock.create({}, { autoSucceed: true });
  await page.goto(mock.url(s));
  await expect(page.getByTestId("test-banner")).toContainText("Test mode — no real funds");
  await expect(page.getByTestId("description")).toHaveText("Pro plan");
  // The unverified merchant name from payments is never rendered (L-CK-03).
  await expect(page.getByText("Acme (unverified)")).toHaveCount(0);
  await page.getByTestId("path-manual").click();
  // Best route preselected (Base · USDC) with its indicative amount (6 significant digits, rounded up);
  // Ethereum is listed but unavailable.
  await expect(page.getByTestId("selected-estimate")).toContainText("2.00502 USDC");
  await page.getByTestId("network-picker-trigger").click();
  await expect(page.getByTestId("network-eip155:1")).toContainText("Too slow");
  await expect(page.getByTestId("network-eip155:1")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("network-intents")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByTestId("token-picker-trigger").click();
  await expect(page.getByTestId(`option-route_quote-${USDC_BASE}`)).toContainText("≈ 2.00502 USDC");
  await expect(page.getByTestId(`option-intents_transfer-${USDC_NEAR}`)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await choose(page, "route_quote", USDC_BASE);
  await expect(page.getByTestId("refund-warning")).toContainText("Do not use an exchange deposit address.");
  await page.getByTestId("refund-address").fill("0x52908400098527886E0F7030069857D2E4169Ee7");
  await page.getByTestId("refund-address").blur();
  await expect(page.getByTestId("refund-error")).toContainText("checksum");
  await expect(page.getByTestId("continue")).toBeDisabled();
  await page.getByTestId("refund-address").fill("0x52908400098527886E0F7030069857D2E4169EE7");
  await page.getByTestId("continue").click();

  // Attested merchant in the header; "Payment details" sheet with the reviewed badge and fingerprint.
  await expect(page.locator(".np-checkout__merchant-name")).toHaveText("Acme GmbH");
  await page.getByTestId("payment-details").click();
  await expect(page.getByRole("dialog", { name: "Payment details" })).toBeVisible();
  await expect(page.getByTestId("merchant-name")).toHaveText("Acme GmbH");
  await expect(page.getByTestId("kyb")).toHaveText("Business details reviewed by NearPay");
  await expect(page.getByTestId("fingerprint")).toHaveText("YZMN-R81Z-BR");
  await expect(page.getByTestId("destination")).toHaveText("USDC · NEAR");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(/verified identity|Verified business/i)).toHaveCount(0);
  await expect(page.getByTestId("network")).toContainText("Use the Base network");
  // Address and amount stay hidden until the payer confirms the network.
  await expect(page.getByTestId("deposit-address")).toHaveCount(0);
  await expect(page.getByTestId("sent")).toBeDisabled();
  await page.getByTestId("confirm-network").check();
  await expect(page.getByTestId("deposit-address")).toContainText("0x76b4c56085ed136a8744d52be956396624a730e8");
  await expect(page.getByTestId("amount-in")).toHaveText("2.005013 USDC");
  await expect(page.getByTestId("qr")).toBeVisible();
  await expect(page.getByTestId("countdown")).toContainText("Expires in 1");

  const created = mock.callsTo("createPaymentAttempt")[0]?.body as Record<string, string>;
  expect(created).toMatchObject({
    method: "route_quote",
    origin_asset_id: USDC_BASE,
    refund_to: "0x52908400098527886E0F7030069857D2E4169EE7",
    turnstile_token: "XXXX.DUMMY.TOKEN.XXXX",
  });
  const att = mock.callsTo("createDepositInstructionsAttestation")[0];
  expect(att?.body).toMatchObject({ kind: "route_quote", livemode: false, attestation_ticket: "eyJhIjoxfQ.c2ln" });
  expect(att?.headers["x-nearpay-client-secret"]).toBeUndefined();

  await page.getByTestId("simulate").click();
  await expect(page.getByTestId("succeeded")).toBeVisible();
  await page.waitForURL(`https://shop.example/thanks?session_id=${s.session.id}`);
});

test("I've sent it signals the deposit and waits for detection", async ({ page, mock }) => {
  const s = mock.create();
  await manualToInstructions(page, mock, s);
  await page.getByTestId("confirm-network").check();
  await page.getByTestId("sent").click();
  await expect(page.getByTestId("processing")).toBeVisible();
  expect(mock.callsTo("signalDepositSent")).toHaveLength(1);
  mock.setAttempt(s, { status: "deposit_detected", attestation_ticket: null });
  await expect(page.getByTestId("processing")).toContainText("Keep this page open while we confirm it");
  mock.succeed(s);
  await expect(page.getByTestId("succeeded")).toBeVisible();
});

test("verifying names the destination chain; Still confirming → Check status gives feedback", async ({
  page,
  mock,
}) => {
  await page.clock.install();
  const s = mock.create({}, { attestDestination: { asset_id: USDC_BASE, chain: "eip155:8453" } });
  await manualToInstructions(page, mock, s);
  await page.getByTestId("confirm-network").check();
  await page.getByTestId("sent").click();
  await expect(page.getByTestId("processing")).toBeVisible();
  mock.setAttempt(s, { status: "deposit_detected", attestation_ticket: null });
  await expect(page.getByTestId("processing")).toContainText("Keep this page open while we confirm it");
  // ADR-0022: the funds are on the merchant's chain; NearPay confirms them on Base's own blocks
  mock.setAttempt(s, { status: "verifying", attestation_ticket: null });
  await expect(page.getByTestId("processing")).toContainText(
    "Payment received — confirming on Base (usually under a minute).",
  );
  // two minutes later: "Still confirming" with a working "Check status"
  await page.clock.fastForward(121_000);
  await expect(page.getByTestId("check-status")).toBeVisible();
  const before = mock.callsTo("getPublicCheckoutSession").length;
  await page.getByTestId("check-status").click();
  await expect(page.getByTestId("check-status")).toHaveAttribute("aria-disabled", "true"); // spinner while reloading
  await expect(page.getByTestId("check-status")).toContainText("Checking…");
  await page.clock.fastForward(1_000);
  await expect(page.getByTestId("checked-at")).toHaveText(/^Still confirming · checked \d{2}:\d{2}:\d{2}$/);
  expect(mock.callsTo("getPublicCheckoutSession").length).toBeGreaterThan(before);
  mock.succeed(s);
  await expect(page.getByTestId("succeeded")).toBeVisible();
});

test("a memo must be confirmed before the address is shown", async ({ page, mock }) => {
  const s = mock.create({}, { memo: "4471" });
  await manualToInstructions(page, mock, s);
  await expect(page.getByTestId("memo")).toHaveText("4471");
  await page.getByTestId("confirm-network").check();
  await expect(page.getByTestId("deposit-address")).toHaveCount(0);
  await page.getByTestId("confirm-memo").check();
  await expect(page.getByTestId("deposit-address")).toBeVisible();
});

for (const mode of [
  "tamper_address",
  "tamper_amount",
  "rogue_key",
  "unknown_kid",
  "wrong_attempt",
  "refused",
  "stale",
  "unavailable",
] as const) {
  test(`failed sentinel verification (${mode}) shows no address`, async ({ page, mock }) => {
    const s = mock.create({}, { sentinel: mode });
    await page.goto(mock.url(s));
    await page.getByTestId("path-manual").click();
    await choose(page, "route_quote", USDC_BASE);
    await page.getByTestId("refund-address").fill("0x52908400098527886E0F7030069857D2E4169EE7");
    await page.getByTestId("continue").click();
    await expect(page.getByTestId("verify-failed")).toBeVisible();
    await expect(page.getByTestId("verify-reason")).toBeVisible();
    const html = await page.content();
    expect(html).not.toContain("0x76b4c56085ed136a8744d52be956396624a730e8");
    expect(html).not.toContain("0x0000000000000000000000000000000000000bad");
    await expect(page.getByTestId("merchant-name")).toHaveCount(0);
    await expect(page.locator(".np-checkout__merchant-name")).toHaveCount(0);
    // Retry creates a new attempt and verifies again.
    s.sentinel = "ok";
    await page.getByTestId("retry").click();
    await choose(page, "route_quote", USDC_BASE);
    await page.getByTestId("refund-address").fill("0x52908400098527886E0F7030069857D2E4169EE7");
    await page.getByTestId("continue").click();
    await expect(page.locator(".np-checkout__merchant-name")).toHaveText("Acme GmbH");
    await expect(page.getByTestId("replaced")).toBeVisible();
    expect(mock.callsTo("createPaymentAttempt")).toHaveLength(2);
  });
}

test("the address expires at the attested deadline", async ({ page, mock }) => {
  const s = mock.create({}, { deadlineS: 4 });
  await manualToInstructions(page, mock, s);
  await page.getByTestId("confirm-network").check();
  await expect(page.getByTestId("deposit-address")).toBeVisible();
  await expect(page.getByTestId("expired-address")).toContainText("This address has expired — do not send.", {
    timeout: 8000,
  });
  await expect(page.getByTestId("deposit-address")).toHaveCount(0);
  s.deadlineS = 900;
  await page.getByTestId("new-address").click();
  await expect(page.getByTestId("asset-picker")).toBeVisible();
});

test("live status: top-up, refund and retry", async ({ page, mock }) => {
  const s = mock.create();
  await manualToInstructions(page, mock, s);
  mock.setAttempt(s, { status: "incomplete_deposit" });
  await expect(page.getByTestId("top-up")).toBeVisible();
  mock.setAttempt(s, { status: "refunded", refunded_amount: "1000000", attestation_ticket: null });
  await expect(page.getByTestId("refunded")).toContainText("Your payment was returned");
  await expect(page.getByTestId("refunded-amount")).toHaveText("1.00 USDC");
  await page.getByTestId("retry").click();
  await expect(page.getByTestId("asset-picker")).toBeVisible();
});

test("held verification shows the review notice", async ({ page, mock }) => {
  const s = mock.create();
  await manualToInstructions(page, mock, s);
  mock.setAttempt(s, { status: "held", attestation_ticket: null });
  mock.setIntent(s, "requires_review");
  await expect(page.getByTestId("review")).toBeVisible();
});

test("polling fallback keeps the page live when the stream is down", async ({ page, mock }) => {
  const s = mock.create({}, { streamDown: true });
  await manualToInstructions(page, mock, s);
  const a = mock.current(s);
  if (!a) throw new Error("no attempt");
  Object.assign(a, { status: "settling", attestation_ticket: null });
  s.session.intent_status = "processing";
  await expect(page.getByTestId("processing")).toBeVisible({ timeout: 10_000 });
  s.session.intent_status = "succeeded";
  s.session.status = "complete";
  await expect(page.getByTestId("succeeded")).toBeVisible({ timeout: 10_000 });
});

test("reload resumes the live attempt after verifying it again", async ({ page, mock }) => {
  const s = mock.create();
  await manualToInstructions(page, mock, s);
  await page.reload();
  await expect(page.locator(".np-checkout__merchant-name")).toHaveText("Acme GmbH");
  expect(mock.callsTo("createDepositInstructionsAttestation")).toHaveLength(2);
  expect(mock.callsTo("createPaymentAttempt")).toHaveLength(1);
});

test("attempt errors: route too slow stays on the picker, geo block blocks", async ({ page, mock }) => {
  const s = mock.create({}, { attemptError: "route_too_slow" });
  await page.goto(mock.url(s));
  await page.getByTestId("path-manual").click();
  await choose(page, "route_quote", USDC_BASE);
  await page.getByTestId("refund-address").fill("0x52908400098527886E0F7030069857D2E4169EE7");
  await page.getByTestId("continue").click();
  await expect(page.getByTestId("error")).toContainText("can't complete in the time left");
  await expect(page.getByTestId("refund-form")).toBeVisible();
  s.attemptError = "geo_blocked";
  await expect(page.getByTestId("continue")).toBeEnabled();
  await page.getByTestId("continue").click();
  await expect(page.getByTestId("blocked-geo_blocked")).toBeVisible();
});

test("blocked: malformed link, wrong secret, expired session, completed session", async ({ page, mock }) => {
  const s = mock.create();
  await page.goto(`${mock.origin}/c/${s.session.id}`);
  await expect(page.getByTestId("blocked-invalid_link")).toBeVisible();
  await page.goto("about:blank");
  await page.goto(`${mock.origin}/c/${s.session.id}#${s.session.id}_secret_${"x".repeat(32)}`);
  await expect(page.getByTestId("blocked-secret_invalid")).toBeVisible();
  const expired = mock.create({ status: "expired", intent_status: "expired" });
  await page.goto(mock.url(expired));
  await expect(page.getByTestId("blocked-session_expired")).toBeVisible();
  const done = mock.create({ status: "complete", intent_status: "succeeded", success_url: "javascript:alert(1)" });
  await page.goto(mock.url(done));
  await expect(page.getByTestId("succeeded")).toBeVisible();
  await expect(page.getByTestId("continue-merchant")).toHaveCount(0);
});

test("malformed payment link ids are refused", async ({ page, mock }) => {
  await page.goto(`${mock.origin}/l/plink_123`);
  await expect(page.getByTestId("blocked-invalid_link")).toBeVisible();
});

test("the client secret never leaves the fragment except in the header", async ({ page, mock }) => {
  const s = mock.create();
  const urls: string[] = [];
  page.on("request", (r) => urls.push(r.url()));
  await manualToInstructions(page, mock, s);
  expect(urls.some((u) => u.includes("_secret_") && !u.includes("#"))).toBe(false);
  for (const c of mock.calls.filter((c) => c.route !== "createDepositInstructionsAttestation"))
    expect(c.headers["x-nearpay-client-secret"]).toBe(s.secret);
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })),
  ).not.toContain("_secret_");
});
