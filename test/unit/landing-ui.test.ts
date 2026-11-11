/** Landing-page look (2026-11-12): chain/token logos, the route, the all-unavailable reason, CSP-safe markup. */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PaymentRoute, routeFrom } from "../../src/app/OrderSummary";
import { allUnavailableReason } from "../../src/features/asset-picker/options";
import { CHAINS } from "../../src/lib/chains/chains";
import { allIconNames, chainIconName, tokenIconName } from "../../src/lib/chains/icons";
import { en } from "../../src/lib/i18n/messages.en";
import { CryptoIcon } from "../../src/ui/CryptoIcon";
import { opt } from "../e2e/support/options";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dir = `${root}public/crypto`;
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("chain and token logos", () => {
  it("covers every network the brief lists, one logo per chain", () => {
    const required: Record<string, string> = {
      "near:mainnet": "chain-near",
      "eip155:1": "chain-ethereum",
      "eip155:8453": "chain-base",
      "eip155:42161": "chain-arbitrum",
      "eip155:10": "chain-optimism",
      "eip155:137": "chain-polygon",
      "eip155:56": "chain-bnb",
      "eip155:43114": "chain-avalanche",
      "eip155:100": "chain-gnosis",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "chain-solana",
      "bip122:000000000019d6689c085ae165831e93": "chain-bitcoin",
    };
    for (const [chain, name] of Object.entries(required)) expect(chainIconName(chain)).toBe(name);
    // Every chain the checkout knows has a logo; NEAR Intents balances show NEAR's.
    for (const c of CHAINS) expect(chainIconName(c.caip2), c.name).not.toBeNull();
    expect(chainIconName("intents")).toBe("chain-near");
    expect(chainIconName("eip155:999999")).toBeNull();
  });

  it("covers the common tokens, case-insensitively, with wrapped aliases; unknown → letter avatar", () => {
    for (const sym of ["USDC", "USDT", "ETH", "SOL", "BTC", "NEAR", "DAI", "WBTC"]) {
      expect(tokenIconName(sym)).toBe(`token-${sym.toLowerCase()}`);
    }
    expect(tokenIconName(" wbtc ")).toBe("token-wbtc");
    expect(tokenIconName("wNEAR")).toBe("token-near");
    expect(tokenIconName("WETH")).toBe("token-eth");
    expect(tokenIconName("MATIC")).toBe("token-pol");
    expect(tokenIconName("PEPE")).toBeNull();
    expect(tokenIconName("XDAI")).toBeNull(); // no xDAI logo in the set: never another token's logo
  });

  it("ships exactly the files the mappings use, unmodified from @web3icons/core, safe as images", () => {
    const names = allIconNames().sort();
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".svg"))
      .map((f) => f.replace(/\.svg$/, ""))
      .sort();
    expect(files).toEqual(names);
    for (const f of files) {
      const svg = readFileSync(`${dir}/${f}.svg`, "utf8");
      expect(svg.startsWith("<svg"), f).toBe(true);
      expect(svg, f).not.toMatch(/<script|<image|<foreignObject|href="http|style=|on[a-z]+=/i);
    }
    expect(readFileSync(`${dir}/LICENSE`, "utf8")).toContain("MIT License");
    expect(
      execFileSync("node", ["scripts/sync-crypto-icons.mjs", "--check"], { cwd: root, encoding: "utf8" }),
    ).toContain("up to date");
  });

  it("renders a self-hosted, decorative image; unknown ids fall back to the letter avatar", () => {
    const token = html(createElement(CryptoIcon, { kind: "token", id: "USDC" }));
    expect(token).toMatch(/<img[^>]*src="\/crypto\/token-usdc\.svg"/);
    expect(token).toContain('alt=""');
    expect(token).toContain("ck-coin--token");
    const chain = html(createElement(CryptoIcon, { kind: "chain", id: "eip155:8453", size: "xs" }));
    expect(chain).toContain('src="/crypto/chain-base.svg"');
    expect(chain).toContain("ck-coin--chain ck-coin--xs");
    const unknown = html(createElement(CryptoIcon, { kind: "token", id: "PEPE" }));
    expect(unknown).not.toContain("<img");
    expect(unknown).toContain(">P<");
    expect(unknown).toContain("ck-coin--letter");
    expect(token + chain + unknown).not.toMatch(/\sstyle=/);
    expect(existsSync(`${dir}/token-usdc.svg`)).toBe(true);
  });
});

describe("route", () => {
  it("token logo on the first stop once a token is known; arrow is decorative CSS", () => {
    const out = html(
      createElement(PaymentRoute, { from: routeFrom("ETH", "Arbitrum One"), token: "ETH", merchant: "Pebble" }),
    );
    expect(out).toContain("ETH on Arbitrum One");
    expect(out).toContain('src="/crypto/token-eth.svg"');
    expect(out).toContain("Pebble&#x27;s wallet");
    expect(out).toMatch(/<ol class="ck-route__stops">/);
    expect(out).not.toMatch(/→|↓/);
    const any = html(createElement(PaymentRoute, { from: null, token: "ETH", merchant: null }));
    expect(any).toContain("Any token");
    expect(any).not.toContain("<img");
  });
});

describe("all options unavailable", () => {
  const usdc = opt("nep141:usdc.near", "near:mainnet", "USDC", 6, "1");
  const off = (reason: string | null) => ({ ...usdc, available: false, reason }) as never;

  it("null while any option is usable, or when there are none", () => {
    expect(allUnavailableReason([])).toBeNull();
    expect(allUnavailableReason([usdc as never, off("route_unavailable")])).toBeNull();
  });
  it("the shared reason, else route_unavailable (paused)", () => {
    expect(allUnavailableReason([off("route_too_slow"), off("route_too_slow")])).toBe("route_too_slow");
    expect(allUnavailableReason([off("amount_too_low")])).toBe("amount_too_low");
    expect(allUnavailableReason([off(null)])).toBe("route_unavailable");
    expect(allUnavailableReason([off("route_too_slow"), off("pricing_unavailable")])).toBe("route_unavailable");
  });
  it("has one message per known reason, in the owner's words for a pause", () => {
    expect(en["asset.allUnavailable.route_unavailable"]).toBe(
      "Payments to this merchant are paused right now. Please try again shortly.",
    );
    for (const r of ["route_too_slow", "amount_too_low", "pricing_unavailable"] as const) {
      expect(en[`asset.allUnavailable.${r}`]).toBeTruthy();
    }
  });
});
