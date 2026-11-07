import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, parseSentinelKeys, resolveConfig, resolveSentinelKeys } from "../../build/config";
import { parseRoute, safeHttpUrl, successRedirect } from "../../src/app/route";
import { payableOptions } from "../../src/features/asset-picker/options";
import { countdown, qrPayload } from "../../src/features/deposit-instructions/qr";
import { validateRefundAddress } from "../../src/features/refund-address/validate";
import { chainFamily, chainName, getChain, walletAsset } from "../../src/lib/chains/chains";
import { errorText, hasMessage, t } from "../../src/lib/i18n/t";
import { computeFingerprint, fingerprintGroups } from "../../src/lib/integrity/fingerprint";
import { currencyExponent, formatBaseUnits, formatFiat, formatPrice, gte } from "../../src/lib/money/format";
import {
  completeMessage,
  envelope,
  initAccepted,
  normalizeOrigin,
  originAllowed,
  parseInit,
  sanitizeAppearance,
} from "../../src/routes/embed/protocol";
import { vector } from "../support/fixtures";
import { session } from "../support/sessions";

const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

describe("amount formatting (INV-5, no floats)", () => {
  it("formats base units exactly", () => {
    expect(formatBaseUnits("2005013", 6)).toBe("2.005013");
    expect(formatBaseUnits("2000000", 6)).toBe("2.00");
    expect(formatBaseUnits("5", 6)).toBe("0.000005");
    expect(formatBaseUnits("123456789012345678901234567890", 24)).toBe("123,456.78901234567890123456789");
    expect(formatBaseUnits("1000", 0)).toBe("1,000");
    expect(formatBaseUnits("10", 1)).toBe("1.0");
    expect(() => formatBaseUnits("1.5", 6)).toThrow();
    expect(() => formatBaseUnits("1", -1)).toThrow();
  });
  it("formats fiat minor units", () => {
    expect(formatFiat(200, "usd")).toBe("$2.00");
    expect(formatFiat(5, "usd")).toBe("$0.05");
    expect(formatFiat(1500, "jpy")).toBe("¥1,500");
    expect(currencyExponent("jpy")).toBe(0);
    expect(currencyExponent("??")).toBe(2);
    expect(() => formatFiat(1.5, "usd")).toThrow();
  });
  it("formats session prices", () => {
    expect(formatPrice(200, "usd")).toBe("$2.00");
    expect(formatPrice("2000000", "asset", { decimals: 6, symbol: "USDC" })).toBe("2.00 USDC");
    expect(formatPrice("2000000", "asset", null)).toBe("2000000 base units");
    expect(() => formatPrice(1, "asset")).toThrow();
    expect(() => formatPrice("1", "usd")).toThrow();
    expect(gte("10", "9")).toBe(true);
  });
});

describe("chains and wallet assets", () => {
  it("names chains", () => {
    expect(chainName("eip155:8453")).toBe("Base");
    expect(chainName("foo:bar")).toBe("foo:bar");
    expect(chainFamily("near:mainnet")).toBe("near");
    expect(chainFamily("foo:bar")).toBeNull();
    expect(getChain("eip155:1")?.evmChainId).toBe(1);
  });
  it("derives the on-chain token of an origin asset", () => {
    expect(walletAsset(USDC_BASE, "eip155:8453")).toEqual({
      kind: "evm_erc20",
      chainId: 8453,
      token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    });
    expect(walletAsset("nep141:eth.omft.near", "eip155:1")).toEqual({ kind: "evm_native", chainId: 1 });
    expect(walletAsset(USDC_BASE, "eip155:1")).toBeNull(); // prefix must belong to the chain
    expect(walletAsset(USDC_BASE, "eip155:10")).toBeNull(); // no omft bridge
    expect(walletAsset(USDC_NEAR, "near:mainnet")).toEqual({ kind: "near_nep141", token: USDC_NEAR.slice(7) });
    expect(walletAsset("nep141:wrap.near", "near:mainnet")).toEqual({ kind: "near_wrap", token: "wrap.near" });
    expect(walletAsset(USDC_BASE, "near:mainnet")).toBeNull();
    expect(walletAsset("nep245:v2_1.omni.hot.tg:56_xyz", "near:mainnet")).toBeNull();
    expect(walletAsset("nep141:x", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).toBeNull();
    expect(walletAsset("nep141:x", "foo:bar")).toBeNull();
  });
});

describe("refund address validation (§5.5)", () => {
  const ok = (chain: string, a: string) => expect(validateRefundAddress(chain, a).ok, a).toBe(true);
  const bad = (chain: string, a: string, reason: string) =>
    expect(validateRefundAddress(chain, a)).toEqual({ ok: false, reason });
  it("EVM", () => {
    ok("eip155:8453", "0x52908400098527886E0F7030069857D2E4169EE7");
    ok("eip155:8453", "0x52908400098527886e0f7030069857d2e4169ee7");
    expect(validateRefundAddress("eip155:1", " 0x52908400098527886e0f7030069857d2e4169ee7 ")).toEqual({
      ok: true,
      normalized: "0x52908400098527886e0f7030069857d2e4169ee7",
    });
    bad("eip155:8453", "0x52908400098527886E0F7030069857D2E4169Ee7", "evm_checksum");
    bad("eip155:8453", "0x1234", "evm_format");
    bad("eip155:8453", "0x0000000000000000000000000000000000000000", "zero_address");
    bad("eip155:8453", "", "empty");
  });
  it("NEAR", () => {
    ok("near:mainnet", "alice.near");
    ok("near:mainnet", "a".repeat(64));
    bad("near:mainnet", "Alice.near", "near_format");
    bad("near:mainnet", "0xABC", "near_format");
  });
  it("Solana", () => {
    ok("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "11111111111111111111111111111111");
    bad("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "abc", "solana_format");
    bad("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "0OIl", "solana_format");
  });
  it("Bitcoin family", () => {
    const btc = "bip122:000000000019d6689c085ae165831e93";
    ok(btc, "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq");
    ok(btc, "BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ");
    ok(btc, "bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297");
    ok(btc, "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2");
    ok(btc, "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy");
    bad(btc, "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdx", "bitcoin_checksum");
    bad(btc, "bc1Qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "bitcoin_format");
    bad(btc, "tb1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "bitcoin_format");
    bad(btc, "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdb!", "bitcoin_format");
    bad(btc, "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3", "bitcoin_checksum");
    bad(btc, "1BvBMSEYstWetqTFn5Au4m4G", "bitcoin_format");
    bad(btc, "0OOO", "bitcoin_format");
    bad("bip122:12a765e31ffd4059bada1e25190f6e98", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", "bitcoin_format");
    bad("foo:bar", "x", "unsupported_chain");
  });
});

describe("fingerprint (shared vector)", () => {
  it("matches every vector case", () => {
    const v = vector<{ cases: { chain: string; address_norm: string; asset_id: string; fingerprint: string }[] }>(
      "destination-fingerprint.json",
    );
    for (const c of v.cases) expect(computeFingerprint(c.chain, c.address_norm, c.asset_id)).toBe(c.fingerprint);
    expect(fingerprintGroups("YZMN-R81Z-BR")).toEqual(["YZMN", "R81Z", "BR"]);
    expect(fingerprintGroups("nope")).toEqual([]);
  });
});

describe("QR payload and countdown", () => {
  it("EIP-681 for EVM tokens, plain address otherwise", () => {
    const token = { kind: "evm_erc20" as const, chainId: 8453, token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" };
    expect(qrPayload("0xabc", "2005013", token)).toBe(
      "ethereum:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@8453/transfer?address=0xabc&uint256=2005013",
    );
    expect(qrPayload("0xabc", "1", { kind: "evm_native", chainId: 1 })).toBe("0xabc");
    expect(qrPayload("bc1q", "1", null)).toBe("bc1q");
  });
  it("formats time left", () => {
    expect(countdown(65_000, 0).label).toBe("1:05");
    expect(countdown(3_725_000, 0).label).toBe("1:02:05");
    expect(countdown(0, 10)).toEqual({ ms: 0, label: "0:00" });
  });
});

describe("routes", () => {
  const id = "cs_01jbz9k3m4n5p6q7r8s9t0v1w2";
  const secret = `${id}_secret_${"A".repeat(32)}`;
  it("parses hosted and embedded links with the fragment secret", () => {
    expect(parseRoute(`/c/${id}`, `#${secret}`)).toEqual({ kind: "hosted", sessionId: id, secret });
    expect(parseRoute(`/embed/${id}/`, `#${secret}`)).toEqual({ kind: "embed", sessionId: id, secret });
    expect(parseRoute(`/c/${id}`, "")).toMatchObject({ secret: null });
    expect(parseRoute(`/c/${id}`, `#cs_01jbz9k3m4n5p6q7r8s9t0v1w3_secret_${"A".repeat(32)}`)).toMatchObject({
      secret: null,
    });
    expect(parseRoute("/c/cs_bad", `#${secret}`)).toMatchObject({ secret: null });
    expect(parseRoute("/l/plink_1", "")).toEqual({ kind: "not_found" }); // ids are validated (Stage 2)
    expect(parseRoute("/l/plink_01jbz9k3m4n5p6q7r8s9t0v1w2", "")).toEqual({
      kind: "payment_link",
      id: "plink_01jbz9k3m4n5p6q7r8s9t0v1w2",
    });
    expect(parseRoute("/i/in_1", "")).toEqual({ kind: "invoice", id: "in_1" });
    expect(parseRoute("/", "")).toEqual({ kind: "not_found" });
  });
  it("redirects only to http(s) success URLs with session_id", () => {
    expect(successRedirect("https://shop.example/done?x=1", id)).toBe(`https://shop.example/done?x=1&session_id=${id}`);
    expect(successRedirect("javascript:alert(1)", id)).toBeNull();
    expect(successRedirect("not a url", id)).toBeNull();
    expect(safeHttpUrl("https://a.example/")).toBe("https://a.example/");
    expect(safeHttpUrl("data:text/html,x")).toBeNull();
    expect(safeHttpUrl("::")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });
});

describe("embed protocol (§5.3, §6)", () => {
  it("parses np:init v1 only", () => {
    expect(
      parseInit({
        type: "np:init",
        v: 1,
        appearance: { theme: "dark", accent: "#ff0000", radius: 8 },
        locale: "en-US",
      }),
    ).toEqual({
      appearance: { theme: "dark", accent: "#ff0000", radius: 8 },
      locale: "en-US",
    });
    expect(parseInit({ type: "np:init", v: 2 })).toBeNull();
    expect(parseInit({ type: "np:other", v: 1 })).toBeNull();
    expect(parseInit("np:init")).toBeNull();
    expect(parseInit(null)).toBeNull();
    expect(parseInit({ type: "np:init", v: 1, locale: "<script>" })?.locale).toBeNull();
  });
  it("sanitises appearance", () => {
    expect(sanitizeAppearance({ theme: "neon", accent: "red; background:url(x)", radius: 99 })).toEqual({
      theme: "auto",
      accent: null,
      radius: null,
    });
    expect(sanitizeAppearance(null)).toEqual({ theme: "auto", accent: null, radius: null });
    expect(sanitizeAppearance({ theme: "light", accent: "#abc", radius: 3.6 })).toEqual({
      theme: "light",
      accent: "#abc",
      radius: 4,
    });
  });
  it("checks origins exactly", () => {
    const allowed = ["https://shop.example", "http://localhost:3000"];
    expect(originAllowed("https://shop.example", allowed)).toBe(true);
    expect(originAllowed("https://shop.example:443", allowed)).toBe(true);
    expect(originAllowed("https://evil.shop.example", allowed)).toBe(false);
    expect(originAllowed("http://shop.example", allowed)).toBe(false);
    expect(originAllowed("null", allowed)).toBe(false);
    expect(normalizeOrigin("ftp://x")).toBeNull();
    expect(initAccepted({ origin: "https://shop.example", fromParent: true }, allowed, "https://shop.example")).toBe(
      true,
    );
    expect(initAccepted({ origin: "https://shop.example", fromParent: true }, allowed, undefined)).toBe(true);
    expect(initAccepted({ origin: "https://shop.example", fromParent: false }, allowed, null)).toBe(false);
    expect(initAccepted({ origin: "https://shop.example", fromParent: true }, allowed, "https://evil.example")).toBe(
      false,
    );
    expect(initAccepted({ origin: "https://evil.example", fromParent: true }, allowed, null)).toBe(false);
  });
  it("versions outbound messages", () => {
    expect(envelope({ type: "np:resize", height: 400 })).toEqual({ type: "np:resize", height: 400, v: 1 });
  });
  it("np:complete reports the session's payment_intent (spec 0.1.5), no SSE intent event needed", () => {
    const s = session({ payment_intent: "pi_01jbz9k3m4n5p6q7r8s9t0v1zz" });
    expect(envelope(completeMessage(s))).toEqual({
      type: "np:complete",
      v: 1,
      session_id: s.id,
      payment_intent_id: "pi_01jbz9k3m4n5p6q7r8s9t0v1zz",
    });
  });
});

describe("payment options per path", () => {
  const opt = (method: "route_quote" | "intents_transfer", asset: string, chain: string, available = true) => ({
    method,
    origin_asset_id: asset,
    chain,
    symbol: "USDC",
    decimals: 6,
    estimated_amount_in: "1",
    route_class: "stable_pair" as const,
    min_deadline_s: 60,
    available,
    reason: available ? null : ("route_too_slow" as const),
  });
  const all = [
    opt("route_quote", USDC_BASE, "eip155:8453", false),
    opt("route_quote", USDC_NEAR, "near:mainnet"),
    opt("intents_transfer", USDC_NEAR, "near:mainnet"),
    opt("route_quote", "nep141:sol-x.omft.near", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"),
    opt("route_quote", USDC_BASE, "eip155:8453"),
  ];
  it("manual: every route_quote option, available first", () => {
    const m = payableOptions(all, "manual", null);
    expect(m.map((o) => o.chain)).toEqual([
      "near:mainnet",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "eip155:8453",
      "eip155:8453",
    ]);
    expect(m.at(-1)?.available).toBe(false);
  });
  it("wallet: only what the wallet can pay, plus Intents transfers", () => {
    expect(payableOptions(all, "wallet", "evm").map((o) => `${o.method}:${o.chain}`)).toEqual([
      "intents_transfer:near:mainnet",
      "route_quote:eip155:8453",
      "route_quote:eip155:8453",
    ]);
    expect(payableOptions(all, "wallet", "near").map((o) => `${o.method}:${o.chain}`)).toEqual([
      "route_quote:near:mainnet",
      "intents_transfer:near:mainnet",
    ]);
    expect(payableOptions(all, "wallet", null)).toEqual([]);
  });
});

describe("i18n", () => {
  it("substitutes placeholders and falls back", () => {
    expect(t("deposit.networkTitle", { chain: "Base" })).toBe("Use the Base network");
    expect(t("deposit.networkTitle")).toBe("Use the {chain} network");
    expect(errorText("too_many_attempts")).toMatch(/Too many/);
    expect(errorText("never_heard_of_it")).toBe(t("error.generic"));
    expect(hasMessage("app.title")).toBe(true);
  });
});

describe("build-time key pinning", () => {
  const key = { kid: "local-1c10f5a1efb1", public_key: "UCYBW7K8JIO7lUomGgB0vG5rjxGnXNfLwVFiEvx9YOg" };
  it("parses and validates pinned keys", () => {
    expect(parseSentinelKeys(JSON.stringify([key]), "x")).toEqual([key]);
    expect(() => parseSentinelKeys("nope", "x")).toThrow(/JSON/);
    expect(() => parseSentinelKeys("[]", "x")).toThrow(/non-empty/);
    expect(() => parseSentinelKeys("[1]", "x")).toThrow(/object/);
    expect(() => parseSentinelKeys(JSON.stringify([{ ...key, kid: "BAD KID" }]), "x")).toThrow(/kid/);
    expect(() => parseSentinelKeys(JSON.stringify([{ ...key, public_key: "AAAA" }]), "x")).toThrow(/32 bytes/);
    expect(() => parseSentinelKeys(JSON.stringify([key, key]), "x")).toThrow(/twice/);
  });
  it("resolves keys from env, file, the deploy secrets, or the test vector for e2e", () => {
    const dir = mkdtempSync(join(tmpdir(), "np-keys-"));
    const file = join(dir, "sentinel_keys.json");
    writeFileSync(file, JSON.stringify([key]));
    expect(resolveSentinelKeys({ VITE_SENTINEL_KEYS: JSON.stringify([key]) }, process.cwd(), false)).toEqual([key]);
    expect(resolveSentinelKeys({ NP_SENTINEL_KEYS_FILE: file }, process.cwd(), false)).toEqual([key]);
    expect(() =>
      resolveSentinelKeys({ NP_SENTINEL_KEYS_FILE: join(dir, "missing.json") }, process.cwd(), false),
    ).toThrow(/seed.sh keys/);
    expect(resolveSentinelKeys({}, process.cwd(), true)).toEqual([
      { kid: "sent-test-1", public_key: "LHE3Fv7ETKuSmfJWAEBI9iPLlmY5mnePtHvXygDK9GA" },
    ]);
  });
  it("builds the CSP and validates URLs", () => {
    const c = resolveConfig({ VITE_SENTINEL_KEYS: JSON.stringify([key]) }, process.cwd(), "production");
    expect(c.apiOrigin).toBe("/api");
    expect(c.nearRpcUrl).toBe("https://free.rpc.fastnear.com");
    const csp = contentSecurityPolicy(c);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self' 'nonce-{{NP_CSP_NONCE}}' https://challenges.cloudflare.com");
    expect(csp).not.toContain("unsafe-inline");
    // NEAR Connect: pinned executors on raw.githubusercontent.com; no runtime manifest host.
    expect(csp).toMatch(/connect-src [^;]*https:\/\/raw\.githubusercontent\.com/);
    expect(csp).not.toContain("cdn.jsdelivr.net");
    const abs = resolveConfig(
      {
        VITE_SENTINEL_KEYS: JSON.stringify([key]),
        VITE_API_ORIGIN: "https://pay.nearpay.money/api/",
        VITE_NEAR_NETWORK: "testnet",
      },
      process.cwd(),
      "production",
    );
    expect(abs.apiOrigin).toBe("https://pay.nearpay.money/api");
    expect(contentSecurityPolicy(abs)).toContain("https://pay.nearpay.money");
    expect(abs.nearRpcUrl).toBe("https://test.rpc.fastnear.com");
    expect(() =>
      resolveConfig(
        { VITE_SENTINEL_KEYS: JSON.stringify([key]), VITE_API_ORIGIN: "http://evil.example" },
        process.cwd(),
        "production",
      ),
    ).toThrow(/https/);
    expect(() =>
      resolveConfig(
        { VITE_SENTINEL_KEYS: JSON.stringify([key]), VITE_API_ORIGIN: "::bad" },
        process.cwd(),
        "production",
      ),
    ).toThrow();
    expect(() =>
      resolveConfig(
        { VITE_SENTINEL_KEYS: JSON.stringify([key]), VITE_NEAR_NETWORK: "devnet" },
        process.cwd(),
        "production",
      ),
    ).toThrow();
  });
});
