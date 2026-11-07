import { USDC_BASE } from "../support/sessions";
import { expect, test } from "./support/fixtures";
import { MerchantSite } from "./support/merchant";

const merchant = new MerchantSite();
test.beforeAll(async () => merchant.start());
test.afterAll(async () => merchant.stop());

type Msg = { type: string; v: number; [k: string]: unknown };
const messages = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as unknown as { __msgs: Msg[] }).__msgs);

test("embedded on an allowed origin: ready, resize, appearance, complete", async ({ page, mock }) => {
  const s = mock.create({ ui_mode: "embedded", allowed_origins: [merchant.origin] }, { autoSucceed: true });
  merchant.iframeSrc = mock.url(s, "embed");
  await page.goto(`${merchant.origin}/shop`);
  const frame = page.frameLocator("#np");
  await expect(frame.getByTestId("choose-path")).toBeVisible();
  await expect.poll(async () => (await messages(page)).map((m) => m.type)).toContain("np:ready");
  const first = await messages(page);
  expect(first[0]).toEqual({ type: "np:ready", v: 1 });
  expect(first.some((m) => m.type === "np:resize" && typeof m.height === "number" && m.height > 100)).toBe(true);
  // Merchant appearance through the ui applyAppearance (CSSOM custom properties, accent kept WCAG AA).
  const look = await page.frames()[1]?.evaluate(() => ({
    theme: document.documentElement.getAttribute("data-theme"),
    accent: document.documentElement.style.getPropertyValue("--np-color-accent"),
    radius: document.documentElement.style.getPropertyValue("--np-radius-control"),
    inline: document.querySelectorAll("[style]").length,
  }));
  expect(look).toMatchObject({ theme: "dark", radius: "4px" });
  // The embedded document paints the merchant's theme (dark surface) over its full height.
  const paint = await page.frames()[1]?.evaluate(() => ({
    html: getComputedStyle(document.documentElement).backgroundColor,
    body: getComputedStyle(document.body).backgroundColor,
  }));
  expect(paint).toEqual({ html: "rgb(25, 58, 63)", body: "rgb(25, 58, 63)" });
  expect(look?.accent).toMatch(/^#[0-9a-f]{6}$/);

  await frame.getByTestId("path-manual").click();
  await frame.getByTestId(`option-route_quote-${USDC_BASE}`).click();
  await frame.getByTestId("refund-address").fill("0x52908400098527886E0F7030069857D2E4169EE7");
  await frame.getByTestId("continue").click();
  await expect(frame.locator(".np-checkout__merchant-name")).toHaveText("Acme GmbH");
  await frame.getByTestId("simulate").click();
  await expect(frame.getByTestId("succeeded")).toBeVisible();
  await expect
    .poll(async () => (await messages(page)).find((m) => m.type === "np:complete"))
    .toEqual({
      type: "np:complete",
      v: 1,
      session_id: s.session.id,
      payment_intent_id: s.intentId,
    });
  // Embedded mode never navigates the frame to success_url.
  expect(page.frames()[1]?.url()).toContain("/embed/");
});

test("embedded, polling only (no SSE): np:complete still carries the session's payment_intent", async ({
  page,
  mock,
}) => {
  const s = mock.create(
    { ui_mode: "embedded", allowed_origins: [merchant.origin] },
    { autoSucceed: true, streamDown: true },
  );
  merchant.iframeSrc = mock.url(s, "embed");
  await page.goto(`${merchant.origin}/shop`);
  const frame = page.frameLocator("#np");
  await frame.getByTestId("path-manual").click();
  await frame.getByTestId(`option-route_quote-${USDC_BASE}`).click();
  await frame.getByTestId("refund-address").fill("0x52908400098527886E0F7030069857D2E4169EE7");
  await frame.getByTestId("continue").click();
  await frame.getByTestId("simulate").click();
  await expect(frame.getByTestId("succeeded")).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => (await messages(page)).find((m) => m.type === "np:complete"))
    .toEqual({ type: "np:complete", v: 1, session_id: s.session.id, payment_intent_id: s.intentId });
});

test("embedded: Close posts np:close to the verified parent", async ({ page, mock }) => {
  const s = mock.create({ ui_mode: "embedded", allowed_origins: [merchant.origin] });
  merchant.iframeSrc = mock.url(s, "embed");
  await page.goto(`${merchant.origin}/shop`);
  await page.frameLocator("#np").getByTestId("close").click();
  await expect.poll(async () => (await messages(page)).map((m) => m.type)).toContain("np:close");
});

test("embedded on an origin that is not allowed: blocked and silent", async ({ page, mock }) => {
  const s = mock.create({ ui_mode: "embedded", allowed_origins: ["https://shop.example"] });
  merchant.iframeSrc = mock.url(s, "embed");
  await page.goto(`${merchant.origin}/shop`);
  await expect(page.frameLocator("#np").getByTestId("blocked-origin_mismatch")).toBeVisible();
  await page.waitForTimeout(500);
  expect(await messages(page)).toEqual([]);
  expect(mock.callsTo("createPaymentAttempt")).toHaveLength(0);
});

test("embed route opened top-level is blocked", async ({ page, mock }) => {
  const s = mock.create({ ui_mode: "embedded", allowed_origins: [merchant.origin] });
  await page.goto(mock.url(s, "embed"));
  await expect(page.getByTestId("blocked-not_framed")).toBeVisible();
});

test("embedded: blocked states after verification are reported with np:error", async ({ page, mock }) => {
  const s = mock.create({ ui_mode: "embedded", allowed_origins: [merchant.origin] }, { attemptError: "geo_blocked" });
  merchant.iframeSrc = mock.url(s, "embed");
  await page.goto(`${merchant.origin}/shop`);
  const frame = page.frameLocator("#np");
  await frame.getByTestId("path-manual").click();
  await frame.getByTestId(`option-route_quote-${USDC_BASE}`).click();
  await frame.getByTestId("refund-address").fill("0x52908400098527886E0F7030069857D2E4169EE7");
  await frame.getByTestId("continue").click();
  await expect(frame.getByTestId("blocked-geo_blocked")).toBeVisible();
  await expect
    .poll(async () => (await messages(page)).find((m) => m.type === "np:error"))
    .toMatchObject({ type: "np:error", v: 1, code: "geo_blocked" });
});
