/** Design v2 (ui 0.5.0): order summary helpers, copy honesty, brand icons, CSP-safe markup. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrderHeader, PaymentRoute, routeFrom, siteOf, WIDE_QUERY } from "../../src/app/OrderSummary";
import { en } from "../../src/lib/i18n/messages.en";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("order summary", () => {
  it("splits at 960 px (owner brief)", () => {
    expect(WIDE_QUERY).toBe("(min-width: 960px)");
  });
  it("route: chosen token → the attested merchant's wallet, generic stops otherwise", () => {
    const known = html(createElement(PaymentRoute, { from: routeFrom("USDC", "Base"), merchant: "Acme GmbH" }));
    expect(known).toContain("How your payment travels");
    expect(known).toContain("USDC on Base");
    expect(known).toContain("Acme GmbH&#x27;s wallet");
    expect(known).toContain("Routed by NEAR Intents straight to the merchant. NearPay never holds your funds.");
    const unknown = html(createElement(PaymentRoute, { from: routeFrom(null, "Base"), merchant: null }));
    expect(unknown).toContain("Any token");
    expect(unknown).toContain("Merchant&#x27;s wallet");
    expect(unknown).not.toContain("→"); // the arrow is a decorative SVG, never text
  });
  it("merchant site: http(s) return URLs only", () => {
    expect(siteOf("https://shop.example/thanks?x=1")).toBe("shop.example");
    expect(siteOf("javascript:alert(1)")).toBeNull();
    expect(siteOf("not a url")).toBeNull();
    expect(siteOf(null)).toBeNull();
  });
  it("phones: header with the description before verification, Order details disclosure, navy on hosted", () => {
    const pre = html(
      createElement(OrderHeader, { merchant: null, title: "Pro plan", amount: "$2.00", details: "lines", navy: true }),
    );
    expect(pre).toContain("np-surface-navy");
    expect(pre).toContain('aria-label="Order summary"');
    expect(pre).toContain(">Pro plan<");
    expect(pre).not.toContain("np-checkout__merchant-name");
    expect(pre).toMatch(/<details[^>]*><summary[^>]*>Order details<\/summary>/);
    const post = html(
      createElement(OrderHeader, { merchant: "Acme GmbH", site: "acme.example", amount: "$2.00", navy: false }),
    );
    expect(post).toContain('class="np-checkout__merchant-name">Acme GmbH<');
    expect(post).toContain("acme.example");
    expect(post).not.toContain("np-surface-navy"); // embedded: the merchant theme's own surface
  });
});

describe("copy (owner rules)", () => {
  const all = Object.values(en).join("\n");
  it("never claims a reviewed or verified business; verification is about the payout address", () => {
    expect(all).not.toMatch(/verified (business|identity|merchant)|reviewed by NearPay|business (is )?verified/i);
    expect(en["trust.verified"]).toBe("Payout address verified for {merchant}");
    expect(en["trust.reviewedText"]).toBe("Business details declared by the merchant");
  });
  it("no arrows in button text, sentence case CTAs", () => {
    for (const key of ["review.pay", "review.sendAnother", "gas.manual", "start.wallet", "test.simulate"] as const) {
      expect(en[key]).not.toContain("→");
      expect(en[key]).not.toMatch(/^[A-Z][a-z]+ [A-Z]/);
    }
    expect(en["app.poweredBy"]).toBe("Powered by NearPay");
  });
});

describe("brand icons", () => {
  const require = createRequire(import.meta.url);
  for (const f of ["favicon.svg", "favicon.ico", "apple-touch-icon.png"]) {
    it(`public/${f} is the kit's brand file`, () => {
      const kit = readFileSync(require.resolve(`@nearpay-internal/ui/brand/${f}`));
      const ours = readFileSync(new URL(`../../public/${f}`, import.meta.url));
      expect(ours.equals(kit)).toBe(true);
    });
  }
  it("index.html links the icons", () => {
    const index = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    expect(index).toContain('<link rel="icon" href="/favicon.ico" sizes="48x48" />');
    expect(index).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
    expect(index).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
  });
});

describe("CSP", () => {
  it("v2 components render without inline style attributes", () => {
    const out =
      html(createElement(PaymentRoute, { from: "USDC on Base", merchant: "Acme GmbH" })) +
      html(createElement(OrderHeader, { merchant: "Acme GmbH", amount: "$2.00", details: "x", navy: true }));
    expect(out).not.toMatch(/\sstyle=/);
  });
});
