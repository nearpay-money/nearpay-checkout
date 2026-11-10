/** Token picker balances: targets per wallet family, filtering and ordering, formatting, and the reads. */
import { INTENTS_CONTRACT } from "@nearpay/spec";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Option } from "../../src/app/machine";
import { readBalances } from "../../src/features/asset-picker/balance-reads";
import { optionKey } from "../../src/features/asset-picker/options";
import { balanceTarget, formatBalance, rowSelectable, tokenRows } from "../../src/features/asset-picker/tokens";
import type { WalletHandle } from "../../src/features/wallet-connect/wallets";
import { roundUpSignificant } from "../../src/lib/money/format";
import type { Eip1193Provider } from "../../src/wallets/evm/provider";
import { availableNear, ftBalanceOf, gasPrice, mtBalanceOf } from "../../src/wallets/near/balances";
import { solBalance, splBalances } from "../../src/wallets/solana/balances";
import { USDC_BASE, USDC_NEAR } from "../support/sessions";

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const DAI = "0x50c5725949a6f0c72e6c4a641f24049a917db0cb";
const SOL_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OWNER = "0x42E06263bb5346ae6421aB1Ec1019824e7B284E1";

const opt = (over: Partial<Option> = {}): Option => ({
  method: "route_quote",
  origin_asset_id: USDC_BASE,
  chain: "eip155:8453",
  symbol: "USDC",
  decimals: 6,
  estimated_amount_in: "2005013",
  route_class: "stable_pair",
  min_deadline_s: 300,
  available: true,
  reason: null,
  ...over,
});
const usdc = opt();
const dai = opt({
  origin_asset_id: `nep141:base-${DAI}.omft.near`,
  symbol: "DAI",
  decimals: 18,
  estimated_amount_in: "2003000000000000000",
});
const eth = opt({
  origin_asset_id: "nep141:base.omft.near",
  symbol: "ETH",
  decimals: 18,
  estimated_amount_in: "600000000000000",
});
const slow = opt({
  origin_asset_id: "nep141:base-0x1111111111111111111111111111111111111111.omft.near",
  symbol: "X",
  available: false,
  reason: "route_too_slow",
});
const nearUsdc = opt({ origin_asset_id: USDC_NEAR, chain: "near:mainnet" });
const wnear = opt({ origin_asset_id: "nep141:wrap.near", chain: "near:mainnet", symbol: "wNEAR", decimals: 24 });
const intents = opt({ method: "intents_transfer", origin_asset_id: USDC_NEAR, chain: "near:mainnet" });
const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const sol = opt({ origin_asset_id: "nep141:sol.omft.near", chain: SOLANA, symbol: "SOL", decimals: 9 });
const spl = opt({
  origin_asset_id: "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near",
  chain: SOLANA,
  token: { standard: "spl", address: SOL_MINT },
});

describe("balanceTarget", () => {
  it("maps each wallet family to the balance that pays the option", () => {
    expect(balanceTarget(usdc, "evm")).toEqual({ kind: "erc20", chainId: 8453, token: USDC });
    expect(balanceTarget(eth, "evm")).toEqual({ kind: "evm_native", chainId: 8453 });
    expect(balanceTarget(usdc, "near")).toBeNull();
    expect(balanceTarget(nearUsdc, "near")).toEqual({ kind: "nep141", token: USDC_NEAR.slice(7) });
    expect(balanceTarget(wnear, "near")).toEqual({ kind: "near_native" });
    expect(balanceTarget(nearUsdc, "evm")).toBeNull();
    expect(balanceTarget(intents, "evm")).toEqual({ kind: "intents", tokenId: USDC_NEAR });
    expect(balanceTarget(intents, "near")).toEqual({ kind: "intents", tokenId: USDC_NEAR });
    expect(balanceTarget(intents, "solana")).toBeNull();
    expect(balanceTarget(sol, "solana")).toEqual({ kind: "sol" });
    expect(balanceTarget(spl, "solana")).toEqual({ kind: "spl", mint: SOL_MINT });
    expect(balanceTarget({ ...spl, token: null }, "solana")).toBeNull();
    expect(balanceTarget({ ...spl, token: { standard: "spl", address: "0xnot-base58" } }, "solana")).toBeNull();
    expect(balanceTarget(usdc, "solana")).toBeNull();
    expect(balanceTarget(opt({ chain: "eip155:999999" }), "evm")).toBeNull();
  });
});

describe("tokenRows", () => {
  const all = [usdc, dai, eth, slow];
  const k = optionKey;
  it("without balances: every option in server order, nothing short", () => {
    const rows = tokenRows(all, null, false);
    expect(rows.map((r) => r.option.symbol)).toEqual(["USDC", "DAI", "ETH", "X"]);
    expect(rows.every((r) => r.balance === null && !r.short)).toBe(true);
    expect(rows.map(rowSelectable)).toEqual([true, true, true, false]);
  });
  it("with balances: hides zero balances, usable first by value, then Not enough, then unavailable", () => {
    const balances = new Map([
      [k(usdc), "12340000"], // 6.15× the payment
      [k(dai), "1500000000000000000"], // below 2.003 → short
      [k(eth), "1000000000000000"], // 1.67×
      [k(slow), "5"],
    ]);
    const rows = tokenRows(all, balances, false);
    expect(rows.map((r) => r.option.symbol)).toEqual(["USDC", "ETH", "DAI", "X"]);
    expect(rows.map((r) => r.short)).toEqual([false, false, true, true]);
    expect(rows.map(rowSelectable)).toEqual([true, true, false, false]);
    const zero = new Map([...balances, [k(usdc), "0"]]);
    expect(tokenRows(all, zero, false).map((r) => r.option.symbol)).toEqual(["ETH", "DAI", "X"]);
    // Show all tokens: server order again, balances still attached.
    const shown = tokenRows(all, zero, true);
    expect(shown.map((r) => [r.option.symbol, r.balance])).toEqual([
      ["USDC", "0"],
      ["DAI", "1500000000000000000"],
      ["ETH", "1000000000000000"],
      ["X", "5"],
    ]);
    expect(shown[0]?.short).toBe(true);
  });
  it("orders by decimal balance when an estimate is missing; unreadable options last in server order", () => {
    const a = opt({
      origin_asset_id: "nep141:base-0x2222222222222222222222222222222222222222.omft.near",
      symbol: "A",
      decimals: 6,
      estimated_amount_in: null,
    });
    const b = opt({
      origin_asset_id: "nep141:base-0x3333333333333333333333333333333333333333.omft.near",
      symbol: "B",
      decimals: 18,
      estimated_amount_in: null,
    });
    const c = opt({ origin_asset_id: "nep141:base-0x4444444444444444444444444444444444444444.omft.near", symbol: "C" });
    const d = opt({ origin_asset_id: "nep141:base-0x5555555555555555555555555555555555555555.omft.near", symbol: "D" });
    const balances = new Map([
      [k(a), "3000000"], // 3.0
      [k(b), "5000000000000000000"], // 5.0
    ]);
    // c and d have no readable balance: kept (we can't say they're empty), after the held ones.
    expect(tokenRows([c, a, d, b], balances, false).map((r) => r.option.symbol)).toEqual(["B", "A", "C", "D"]);
    const zeroEst = opt({ ...a, estimated_amount_in: "0", symbol: "Z" });
    expect(
      tokenRows(
        [zeroEst, b],
        new Map([
          [k(zeroEst), "1"],
          [k(b), "1"],
        ]),
        false,
      ).map((r) => r.option.symbol),
    ).toEqual(["Z", "B"]);
    // equal value keeps server order
    const e = opt({ ...c, symbol: "E" });
    const f = opt({ ...d, symbol: "F" });
    expect(
      tokenRows(
        [e, f],
        new Map([
          [k(e), "7"],
          [k(f), "7"],
        ]),
        false,
      ).map((r) => r.option.symbol),
    ).toEqual(["E", "F"]);
  });
});

describe("formatting", () => {
  it("balances: exact digits up to 6 decimals, rounded down, dust shown as < 0.000001", () => {
    expect(formatBalance("12340000", 6)).toBe("12.34");
    expect(formatBalance("0", 6)).toBe("0.00");
    expect(formatBalance("1234567891", 6)).toBe("1,234.567891");
    expect(formatBalance("1999999999999999999", 18)).toBe("1.999999");
    expect(formatBalance("1", 18)).toBe("< 0.000001");
    expect(formatBalance("1", 2)).toBe("0.01");
    expect(formatBalance("5", 0)).toBe("5");
    expect(formatBalance("1000000000000000000000000000000", 24)).toBe("1,000,000.00");
  });
  it("amounts needed: rounded up to 2 significant digits", () => {
    expect(roundUpSignificant(781_000_000_000n)).toBe(790_000_000_000n);
    expect(roundUpSignificant(780_000_000_000n)).toBe(780_000_000_000n);
    expect(roundUpSignificant(99n)).toBe(99n);
    expect(roundUpSignificant(101n)).toBe(110n);
    expect(roundUpSignificant(0n)).toBe(0n);
    expect(roundUpSignificant(-5n)).toBe(0n);
    expect(roundUpSignificant(12345n, 3)).toBe(12400n);
  });
});

// ---- reads ----------------------------------------------------------------------------------------------

type Handler = (method: string, params: unknown[]) => unknown;
function provider(h: Handler): Eip1193Provider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async request({ method, params }: { method: string; params?: unknown[] | object }) {
      calls.push(method);
      const r = h(method, (params as unknown[]) ?? []);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

const evmWallet = (p: Eip1193Provider): WalletHandle => ({ family: "evm", address: OWNER, label: "W", provider: p });
const nearWallet: WalletHandle = {
  family: "near",
  address: "payer.near",
  label: "N",
  wallet: {} as never,
};
const solWallet: WalletHandle = {
  family: "solana",
  address: "EyjEeiTxb4rvkoN3ZA2zTimuc6VyF8V1QuH9TT66Gkn6",
  label: "S",
  wallet: {} as never,
};
const CFG = { nearRpcUrl: "https://rpc.near.test", solanaRpcUrl: "https://rpc.sol.test" };

/** fetch stub answering NEAR / Solana JSON-RPC by method (and NEAR view method name). */
function stubFetch(answer: (body: { method: string; params: Record<string, unknown> & unknown[] }) => unknown) {
  const bodies: { method: string; params: Record<string, unknown> & unknown[] }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const r = answer(body);
      if (r instanceof Response) return r;
      return new Response(JSON.stringify(r === undefined ? { error: { message: "nope" } } : { result: r }), {
        status: 200,
      });
    }),
  );
  return bodies;
}
const view = (v: unknown) => ({ result: Array.from(new TextEncoder().encode(JSON.stringify(v))) });
const argsOf = (b: { params: Record<string, unknown> }) =>
  JSON.parse(atob(b.params.args_base64 as string)) as Record<string, string>;

afterEach(() => vi.unstubAllGlobals());

describe("readBalances", () => {
  it("EVM: balanceOf + eth_getBalance through the wallet's provider, only on that chain", async () => {
    const p = provider((m, params) => {
      if (m === "eth_chainId") return "0x2105";
      if (m === "eth_getBalance") return "0x38d7ea4c68000"; // 0.001 ETH
      if (m === "eth_call") {
        const c = params[0] as { to: string; data: string };
        expect(c.data).toBe(`0x70a08231${OWNER.slice(2).toLowerCase().padStart(64, "0")}`);
        return c.to === USDC ? "0xbc4b20" : "0x";
      }
      return new Error("unsupported");
    });
    stubFetch(() => new Response("", { status: 500 }));
    const r = await readBalances(evmWallet(p), [usdc, dai, eth, intents], CFG).catch((e) => e);
    // Intents balances come from the NEAR RPC: when it fails, the read fails as a whole (full-list fallback).
    expect(r).toBeInstanceOf(Error);
    const ok = await readBalances(evmWallet(p), [usdc, dai, eth], CFG);
    expect(ok).toEqual({
      state: "ok",
      balances: new Map([
        [optionKey(usdc), "12340000"],
        [optionKey(dai), "0"],
        [optionKey(eth), "1000000000000000"],
      ]),
    });
    const other = provider((m) => (m === "eth_chainId" ? "0x1" : new Error("must not read")));
    expect(await readBalances(evmWallet(other), [usdc], CFG)).toEqual({ state: "wrong_chain", chain: "eip155:8453" });
    expect(other.calls).toEqual(["eth_chainId"]);
    expect(await readBalances(evmWallet(p), [nearUsdc], CFG)).toEqual({ state: "none" });
    const bad = provider((m) => (m === "eth_chainId" ? "0x2105" : "not hex"));
    await expect(readBalances(evmWallet(bad), [usdc], CFG)).rejects.toThrow("balanceOf");
  });
  it("EVM signer's NEAR Intents balance: mt_balance_of on intents.near for the lower-case address", async () => {
    const bodies = stubFetch(() => view("2006000"));
    const p = provider(() => new Error("no EVM read needed"));
    const r = await readBalances(evmWallet(p), [intents], CFG);
    expect(r).toEqual({ state: "ok", balances: new Map([[optionKey(intents), "2006000"]]) });
    expect(bodies[0]?.params.account_id).toBe(INTENTS_CONTRACT);
    expect(argsOf(bodies[0] as never)).toEqual({ account_id: OWNER.toLowerCase(), token_id: USDC_NEAR });
  });
  it("NEAR: ft_balance_of, native (minus storage) for wNEAR, Intents", async () => {
    stubFetch((b) => {
      if (b.params.request_type === "view_account") return { amount: "5000000000000000000000000", storage_usage: 1000 };
      const m = b.params.method_name;
      if (m === "ft_balance_of") return view("7000000");
      if (m === "mt_balance_of") return view("0");
      return undefined;
    });
    const r = await readBalances(nearWallet, [nearUsdc, wnear, intents], CFG);
    expect(r).toEqual({
      state: "ok",
      balances: new Map([
        [optionKey(nearUsdc), "7000000"],
        [optionKey(wnear), "4990000000000000000000000"],
        [optionKey(intents), "0"],
      ]),
    });
  });
  it("Solana: getBalance and one getTokenAccountsByOwner summed by mint", async () => {
    const bodies = stubFetch((b) => {
      if (b.method === "getBalance") return { value: 2_000_000_000 };
      if (b.method === "getTokenAccountsByOwner")
        return {
          value: [
            { account: { data: { parsed: { info: { mint: SOL_MINT, tokenAmount: { amount: "1000000" } } } } } },
            { account: { data: { parsed: { info: { mint: SOL_MINT, tokenAmount: { amount: "234" } } } } } },
            {
              account: {
                data: { parsed: { info: { mint: "Other1111111111111111111111111111", tokenAmount: { amount: "9" } } } },
              },
            },
          ],
        };
      return undefined;
    });
    const spl2 = opt({
      ...spl,
      origin_asset_id: "nep141:sol-1111111111111111111111111111111111111111.omft.near",
      token: { standard: "spl", address: "So11111111111111111111111111111111111111112" },
    });
    const r = await readBalances(solWallet, [sol, spl, spl2], CFG);
    expect(r).toEqual({
      state: "ok",
      balances: new Map([
        [optionKey(sol), "2000000000"],
        [optionKey(spl), "1000234"],
        [optionKey(spl2), "0"],
      ]),
    });
    expect(bodies.filter((b) => b.method === "getTokenAccountsByOwner")).toHaveLength(1); // one call for all mints
  });
});

describe("NEAR / Solana balance parsing", () => {
  it("refuses malformed answers", async () => {
    stubFetch((b) => (b.params?.request_type === "view_account" ? { amount: "1", storage_usage: -1 } : view("1.5")));
    await expect(ftBalanceOf("https://r", "t.near", "a.near")).rejects.toThrow("ft_balance_of");
    await expect(mtBalanceOf("https://r", "intents.near", "a.near", "nep141:t")).rejects.toThrow("mt_balance_of");
    await expect(availableNear("https://r", "a.near")).rejects.toThrow("storage_usage");
    stubFetch(() => ({ amount: "1", storage_usage: 10 }));
    expect(await availableNear("https://r", "a.near")).toBe("0"); // storage locks more than the amount
    stubFetch(() => ({ gas_price: "100000000" }));
    expect(await gasPrice("https://r")).toBe("100000000");
    stubFetch(() => ({ gas_price: 1 }));
    await expect(gasPrice("https://r")).rejects.toThrow("gas_price");
    stubFetch(() => null);
    await expect(gasPrice("https://r")).rejects.toThrow("gas_price failed");
    stubFetch(() => ({ value: 2 ** 60 }));
    await expect(solBalance("https://s", "o")).rejects.toThrow("malformed balance");
    stubFetch(() => ({ value: "nope" }));
    await expect(splBalances("https://s", "o")).rejects.toThrow("malformed token accounts");
    stubFetch(() => ({
      value: [{ account: { data: { parsed: { info: { mint: "m", tokenAmount: { amount: 5 } } } } } }],
    }));
    await expect(splBalances("https://s", "o")).rejects.toThrow("malformed token account");
    stubFetch(() => new Response("", { status: 503 }));
    await expect(solBalance("https://s", "o")).rejects.toThrow("503");
  });
});
