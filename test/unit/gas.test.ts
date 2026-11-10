/** Network-fee pre-check before a wallet signs (EVM, Solana, NEAR): fee estimates, margins, verdicts. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assessFee,
  checkEvm,
  checkNear,
  checkSolana,
  NEAR_GAS_MARGIN,
  SOL_ACCOUNT_RENT_MIN,
  SOL_SIGNATURE_FEE,
} from "../../src/features/gas-check/gas";
import type { Eip1193Provider } from "../../src/wallets/evm/provider";
import {
  erc20BalanceOf,
  hexToBigint,
  L1_FEE_UPPER_BOUND,
  nativeBalance,
  networkFee,
  OP_GAS_ORACLE,
  walletChainId,
} from "../../src/wallets/evm/reads";
import { evmPaymentTx } from "../../src/wallets/evm/tx";
import { nearDepositTransactions } from "../../src/wallets/near/tx";

const FROM = "0x42E06263bb5346ae6421aB1Ec1019824e7B284E1";
const DEPOSIT = "0x76b4c56085ed136a8744d52be956396624a730e8";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const erc20 = { kind: "evm_erc20" as const, chainId: 8453, token: USDC };
const native = { kind: "evm_native" as const, chainId: 8453 };
const hex = (n: bigint) => `0x${n.toString(16)}`;

function provider(
  answers: Record<string, unknown>,
): Eip1193Provider & { calls: { method: string; params: unknown }[] } {
  const calls: { method: string; params: unknown }[] = [];
  return {
    calls,
    async request({ method, params }: { method: string; params?: unknown[] | object }) {
      calls.push({ method, params });
      const a = answers[method];
      const v = typeof a === "function" ? (a as (p: unknown) => unknown)(params) : a;
      if (v === undefined || v instanceof Error) throw v ?? new Error(`unsupported ${method}`);
      return v;
    },
  };
}

describe("assessFee", () => {
  it("funds before fee; the fee comes on top of a native payment; Solana keeps the rent-exempt minimum", () => {
    expect(assessFee({ native: 10n, fee: 3n, sendNative: 0n })).toEqual({ ok: true });
    expect(assessFee({ native: 2n, fee: 3n, sendNative: 0n })).toEqual({ ok: false, reason: "fee", need: 3n });
    expect(assessFee({ native: 0n, fee: 3n, sendNative: 0n, token: { balance: 5n, amount: 5n } })).toEqual({
      ok: false,
      reason: "fee",
      need: 3n,
    });
    expect(assessFee({ native: 9n, fee: 3n, sendNative: 0n, token: { balance: 4n, amount: 5n } })).toEqual({
      ok: false,
      reason: "funds",
    });
    expect(assessFee({ native: 4n, fee: 3n, sendNative: 5n })).toEqual({ ok: false, reason: "funds" });
    expect(assessFee({ native: 7n, fee: 3n, sendNative: 5n })).toEqual({ ok: false, reason: "fee", need: 3n });
    expect(assessFee({ native: 8n, fee: 3n, sendNative: 5n })).toEqual({ ok: true }); // exactly enough
    expect(assessFee({ native: 9n, fee: 3n, sendNative: 5n, minRemaining: 2n })).toEqual({
      ok: false,
      reason: "fee",
      need: 5n,
    });
    expect(assessFee({ native: 10n, fee: 3n, sendNative: 5n, minRemaining: 2n })).toEqual({ ok: true });
    expect(assessFee({ native: 8n, fee: 3n, sendNative: 5n, minRemaining: 2n })).toEqual({ ok: true }); // drains to 0
  });
});

describe("EVM reads through the wallet provider", () => {
  it("chain id, balanceOf, native balance; malformed answers refused", async () => {
    const p = provider({ eth_chainId: "0x2105", eth_call: "0x0bc4b20", eth_getBalance: "0x" });
    expect(await walletChainId(p)).toBe(8453);
    expect(await erc20BalanceOf(p, USDC, FROM)).toBe(12_340_000n);
    expect(await nativeBalance(p, FROM)).toBe(0n);
    await expect(erc20BalanceOf(p, "nope", FROM)).rejects.toThrow(RangeError);
    await expect(nativeBalance(p, "nope")).rejects.toThrow(RangeError);
    expect(() => hexToBigint(12, "x")).toThrow("unexpected x");
    expect(() => hexToBigint(`0x${"f".repeat(65)}`, "x")).toThrow();
    await expect(walletChainId(provider({ eth_chainId: hex(2n ** 60n) }))).rejects.toThrow("eth_chainId");
  });

  it("network fee: estimate +20 % × max(gasPrice, 2 × baseFee + tip), value 0x0, plus the OP-stack L1 bound", async () => {
    const tx = evmPaymentTx(erc20, DEPOSIT, "2005013", FROM);
    const p = provider({
      eth_estimateGas: hex(65_000n),
      eth_gasPrice: hex(9_000_000n),
      eth_getBlockByNumber: { baseFeePerGas: hex(5_000_000n) },
      eth_maxPriorityFeePerGas: hex(1_000_000n),
      eth_call: (params: unknown) => {
        const c = (params as { to: string; data: string }[])[0] as { to: string; data: string };
        expect(c.to).toBe(OP_GAS_ORACLE);
        expect(c.data).toBe(`${L1_FEE_UPPER_BOUND}${(200).toString(16).padStart(64, "0")}`);
        return hex(1_000_000_000n);
      },
    });
    // 78 000 gas × 11 000 000 wei + 1e9 L1
    expect(await networkFee(p, tx, 8453)).toBe(78_000n * 11_000_000n + 1_000_000_000n);
    const est = p.calls.find((c) => c.method === "eth_estimateGas")?.params as Record<string, string>[];
    expect(est[0]).toEqual({ ...tx, value: "0x0" });

    // No EIP-1559 data, not an OP-stack chain: gasPrice alone; the estimate rounds up.
    const legacy = provider({ eth_estimateGas: hex(21_001n), eth_gasPrice: hex(10n) });
    expect(await networkFee(legacy, evmPaymentTx(native, DEPOSIT, "5", FROM), 1)).toBe(25_202n * 10n);
    // Higher gasPrice wins over the EIP-1559 bound; a failing L1 oracle adds nothing.
    const high = provider({
      eth_estimateGas: hex(50_000n),
      eth_gasPrice: hex(100n),
      eth_getBlockByNumber: { baseFeePerGas: hex(10n) },
      eth_maxPriorityFeePerGas: "bad",
      eth_call: new Error("execution reverted"),
    });
    expect(await networkFee(high, tx, 10)).toBe(60_000n * 100n);
    await expect(networkFee(provider({ eth_gasPrice: "0x1" }), tx, 1)).rejects.toThrow();
  });

  it("checkEvm: token or native shortfall before estimating; fee short; enough", async () => {
    // balanceOf answers; the Base L1-fee oracle is "missing" here (its bound is tested above).
    const tokenCall = (v: bigint) => (params: unknown) =>
      (params as { to: string }[])[0]?.to === OP_GAS_ORACLE ? new Error("no oracle") : hex(v);
    const gas = {
      eth_estimateGas: hex(50_000n),
      eth_gasPrice: hex(1_000_000_000n), // 1 gwei → 60 000 gas = 0.00006 ETH
    };
    const tx = evmPaymentTx(erc20, DEPOSIT, "2005013", FROM);
    const short = provider({ ...gas, eth_getBalance: "0x0", eth_call: tokenCall(2_005_013n) });
    expect(await checkEvm(short, tx, erc20, "2005013")).toEqual({
      ok: false,
      reason: "fee",
      need: 60_000_000_000_000n,
    });
    const noToken = provider({ ...gas, eth_getBalance: hex(10n ** 18n), eth_call: tokenCall(5n) });
    expect(await checkEvm(noToken, tx, erc20, "2005013")).toEqual({ ok: false, reason: "funds" });
    expect(noToken.calls.some((c) => c.method === "eth_estimateGas")).toBe(false);
    const rich = provider({ ...gas, eth_getBalance: hex(10n ** 18n), eth_call: tokenCall(10n ** 9n) });
    expect(await checkEvm(rich, tx, erc20, "2005013")).toEqual({ ok: true });

    const ntx = evmPaymentTx(native, DEPOSIT, "600000000000000", FROM);
    const exact = provider({ ...gas, eth_getBalance: hex(600_000_000_000_000n) });
    expect(await checkEvm(exact, ntx, native, "600000000000000")).toEqual({
      ok: false,
      reason: "fee",
      need: 60_000_000_000_000n,
    });
    const less = provider({ ...gas, eth_getBalance: hex(1n) });
    expect(await checkEvm(less, ntx, native, "600000000000000")).toEqual({ ok: false, reason: "funds" });
  });
});

afterEach(() => vi.unstubAllGlobals());

function stubFetch(answer: (body: { method: string; params: Record<string, unknown> }) => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init: { body: string }) => {
      const r = answer(JSON.parse(init.body));
      return new Response(JSON.stringify(r === undefined ? { error: { message: "x" } } : { result: r }), {
        status: 200,
      });
    }),
  );
}
const view = (v: unknown) => ({ result: Array.from(new TextEncoder().encode(JSON.stringify(v))) });

describe("Solana", () => {
  const sol = { kind: "sol" as const, deposit: "D", lamports: "1500000000" };
  const spl = { kind: "spl" as const, deposit: "D", mint: "M", decimals: 6, amount: "25012345" };
  const answers = (lamports: number, held: string) => (b: { method: string }) =>
    b.method === "getBalance"
      ? { value: lamports }
      : { value: [{ account: { data: { parsed: { info: { mint: "M", tokenAmount: { amount: held } } } } } }] };

  it("two signature fees + token-account rent; SOL keeps the rent-exempt minimum or drains to 0", async () => {
    const fee = SOL_SIGNATURE_FEE * 2n;
    stubFetch(answers(0, "25012345"));
    expect(await checkSolana("https://s", "O", spl, "2039280")).toEqual({
      ok: false,
      reason: "fee",
      need: fee + 2_039_280n,
    });
    stubFetch(answers(10_000_000, "1"));
    expect(await checkSolana("https://s", "O", spl, null)).toEqual({ ok: false, reason: "funds" });
    stubFetch(answers(10_000_000, "25012345"));
    expect(await checkSolana("https://s", "O", spl, null)).toEqual({ ok: true });
    stubFetch(answers(1_500_000_000 + Number(fee) + 1000, "0"));
    expect(await checkSolana("https://s", "O", sol, null)).toEqual({
      ok: false,
      reason: "fee",
      need: fee + SOL_ACCOUNT_RENT_MIN,
    });
    stubFetch(answers(1_500_000_000 + Number(fee), "0"));
    expect(await checkSolana("https://s", "O", sol, null)).toEqual({ ok: true });
    stubFetch(answers(2_000_000_000, "0"));
    expect(await checkSolana("https://s", "O", sol, null)).toEqual({ ok: true });
  });
});

describe("NEAR", () => {
  const nep141 = { kind: "near_nep141" as const, token: "usdc.near" };
  const txs = nearDepositTransactions({
    asset: nep141,
    depositAddress: "d.near",
    amountIn: "2003000",
    memo: null,
    registered: false,
    storageMin: "1250000000000000000000",
  });
  const answers = (amount: string, ft: string) => (b: { method: string; params: Record<string, unknown> }) =>
    b.method === "gas_price"
      ? { gas_price: "100000000" }
      : b.params.request_type === "view_account"
        ? { amount, storage_usage: 0 }
        : view(ft);
  // (10 + 30) Tgas × 1e8 × 2 + storage 0.00125 NEAR + 1 yocto
  const need = 40_000_000_000_000n * 100_000_000n * NEAR_GAS_MARGIN + 1_250_000_000_000_000_000_001n;

  it("attached gas × price × 2 plus deposits; token shortfall first; wNEAR sends the amount natively", async () => {
    stubFetch(answers("0", "2003000"));
    expect(await checkNear("https://n", "p.near", txs, { token: "usdc.near", amount: "2003000" })).toEqual({
      ok: false,
      reason: "fee",
      need,
    });
    stubFetch(answers("10000000000000000000000000", "1"));
    expect(await checkNear("https://n", "p.near", txs, { token: "usdc.near", amount: "2003000" })).toEqual({
      ok: false,
      reason: "funds",
    });
    stubFetch(answers(need.toString(), "2003000"));
    expect(await checkNear("https://n", "p.near", txs, { token: "usdc.near", amount: "2003000" })).toEqual({
      ok: true,
    });

    const wrap = nearDepositTransactions({
      asset: { kind: "near_wrap", token: "wrap.near" },
      depositAddress: "d.near",
      amountIn: "1000000000000000000000000",
      memo: null,
      registered: true,
      storageMin: "0",
    });
    stubFetch(answers("1000000000000000000000000", "0"));
    const v = await checkNear("https://n", "p.near", wrap, null);
    expect(v).toEqual({ ok: false, reason: "fee", need: 40_000_000_000_000n * 100_000_000n * 2n + 1n });
    stubFetch(answers("999", "0"));
    expect(await checkNear("https://n", "p.near", wrap, null)).toEqual({ ok: false, reason: "funds" });
  });
});
