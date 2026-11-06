/** Playwright fixtures: the mock NearPay (worker-scoped), a stubbed Turnstile, CSP-violation guard. */
import { fileURLToPath } from "node:url";
import { test as base, expect, type Page } from "@playwright/test";
import { MockNearPay } from "./mock-server";

const DIST = fileURLToPath(new URL("../../../dist-e2e", import.meta.url));

export const TURNSTILE_STUB = `window.turnstile = {
  render(el, o) { setTimeout(() => o.callback("XXXX.DUMMY.TOKEN.XXXX"), 20); return "w" + Math.random(); },
  reset() {}, remove() {}
};`;

export async function stubExternal(page: Page): Promise<void> {
  await page.route("https://challenges.cloudflare.com/**", (r) =>
    r.fulfill({ status: 200, contentType: "text/javascript", body: TURNSTILE_STUB }),
  );
  await page.route("https://shop.example/**", (r) =>
    r.fulfill({ status: 200, contentType: "text/html", body: "<h1>merchant</h1>" }),
  );
}

export const test = base.extend<{ cspViolations: string[] }, { mock: MockNearPay }>({
  mock: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture dependencies from the destructuring
    async ({}, use) => {
      const m = new MockNearPay(DIST);
      await m.start();
      await use(m);
      await m.stop();
    },
    { scope: "worker" },
  ],
  cspViolations: [
    async ({ page, mock }, use) => {
      mock.reset();
      const violations: string[] = [];
      page.on("console", (msg) => {
        if (/Refused to (load|execute|apply|connect|frame)/.test(msg.text())) violations.push(msg.text());
      });
      await stubExternal(page);
      await use(violations);
      expect(violations, "CSP violations").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
