import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  ensureChain,
  personalSign,
  requestAccount,
  safeIcon,
  sendTransaction,
  WalletRejected,
} from "../../src/wallets/evm/provider";
import { ERC20_TRANSFER, erc20TransferData, evmPaymentTx, hexChainId, uintHex } from "../../src/wallets/evm/tx";
import {
  erc191Payload,
  intentMessage,
  makeNonce,
  nep413Message,
  nep413Payload,
  SANDBOX_SALT,
  transferIntents,
} from "../../src/wallets/intents/message";
import { currentSalt, storageBalanceBounds, storageBalanceOf, viewFunction } from "../../src/wallets/near/rpc";
import { depositTxHash, nearDepositTransactions } from "../../src/wallets/near/tx";
import { vector } from "../support/fixtures";

const iv = vector<{
  salt_hex: string;
  nonce_base64: string;
  binding: string;
  nep413: {
    seed_hex: string;
    signer_id: string;
    multipayload: { payload: { message: string; nonce: string }; public_key: string; signature: string };
  };
  erc191: { private_key_hex: string; address: string; multipayload: { payload: string; signature: string } };
}>("intents-payloads.json");

const REQ = {
  pay_to: "merchant.near",
  token: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  amount: "2000000",
  fee_to: "treasury.nearpay.near",
  fee_amount: "6000",
  binding: iv.binding,
  deadline: "2026-11-05T10:02:00.000Z",
};
const NONCE = Uint8Array.from(Buffer.from(iv.nonce_base64, "base64"));

describe("intents messages (shared vectors)", () => {
  it("builds the NEP-413 message of the vector", () => {
    const m = intentMessage(REQ, iv.nep413.signer_id, NONCE);
    expect(nep413Message(m)).toBe(iv.nep413.multipayload.payload.message);
    expect(m.nonce).toBe(iv.nonce_base64);
  });

  it("turns a wallet signMessage result into the vector MultiPayload (base64 and ed25519: forms)", () => {
    const m = intentMessage(REQ, iv.nep413.signer_id, NONCE);
    const sigB58 = iv.nep413.multipayload.signature;
    const raw = Buffer.from(bs58.decode(sigB58.slice(8)));
    const fromB64 = nep413Payload(m, {
      publicKey: iv.nep413.multipayload.public_key,
      signature: raw.toString("base64"),
    });
    expect(fromB64).toEqual(iv.nep413.multipayload);
    expect(nep413Payload(m, { publicKey: iv.nep413.multipayload.public_key, signature: sigB58 })).toEqual(
      iv.nep413.multipayload,
    );
    expect(() => nep413Payload(m, { publicKey: "bad", signature: sigB58 })).toThrow();
    expect(() => nep413Payload(m, { publicKey: iv.nep413.multipayload.public_key, signature: "AAAA" })).toThrow();
  });

  it("builds the ERC-191 payload and normalises v from a personal_sign signature", () => {
    const m = intentMessage(REQ, iv.erc191.address, NONCE);
    expect(JSON.stringify(m)).toBe(iv.erc191.multipayload.payload);
    const bytes = new TextEncoder().encode(iv.erc191.multipayload.payload);
    const hash = keccak_256(
      new Uint8Array([...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${bytes.length}`), ...bytes]),
    );
    const rec = secp256k1.sign(hash, Buffer.from(iv.erc191.private_key_hex, "hex"), {
      prehash: false,
      format: "recovered",
    });
    const rs = Buffer.from(rec.slice(1)).toString("hex");
    for (const v of [rec[0] as number, (rec[0] as number) + 27]) {
      const hex = `0x${rs}${v.toString(16).padStart(2, "0")}`;
      expect(erc191Payload(m, hex)).toEqual({ standard: "erc191", ...iv.erc191.multipayload });
    }
    expect(() => erc191Payload(m, `0x${rs}05`)).toThrow();
    expect(() => erc191Payload(m, "0x12")).toThrow();
  });

  it("nonce = salt ‖ 28 random bytes", () => {
    const n = makeNonce(iv.salt_hex, () => NONCE.slice(4));
    expect(Buffer.from(n).toString("base64")).toBe(iv.nonce_base64);
    expect(makeNonce(SANDBOX_SALT).length).toBe(32);
    expect(() => makeNonce("XYZ")).toThrow();
    expect(() => makeNonce(iv.salt_hex, () => new Uint8Array(3))).toThrow();
  });

  it("refuses a zero merchant amount", () => {
    expect(() => transferIntents({ ...REQ, amount: "0" })).toThrow();
  });
});

describe("EVM transfers", () => {
  const to = "0x76b4c56085ed136a8744d52be956396624a730e8";
  it("encodes ERC-20 transfer calldata", () => {
    const data = erc20TransferData(to, "2005013");
    expect(data.startsWith(ERC20_TRANSFER)).toBe(true);
    expect(data).toBe(
      `0xa9059cbb${"0".repeat(24)}76b4c56085ed136a8744d52be956396624a730e8${"1e9815".padStart(64, "0")}`,
    );
    expect(() => erc20TransferData("0x12", "1")).toThrow();
    expect(() => uintHex("-1")).toThrow();
    expect(() => uintHex((1n << 256n).toString())).toThrow();
  });
  it("builds token and native transactions from attested values", () => {
    const from = "0x42e06263bb5346ae6421ab1ec1019824e7b284e1";
    expect(
      evmPaymentTx(
        { kind: "evm_erc20", chainId: 8453, token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
        to,
        "2005013",
        from,
      ),
    ).toEqual({
      from,
      to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      value: "0x0",
      data: erc20TransferData(to, "2005013"),
    });
    expect(evmPaymentTx({ kind: "evm_native", chainId: 1 }, to, "1000000000000000000", from)).toEqual({
      from,
      to,
      value: "0xde0b6b3a7640000",
    });
    expect(() => evmPaymentTx({ kind: "evm_native", chainId: 1 }, to, "1", "nope")).toThrow();
    expect(() => evmPaymentTx({ kind: "evm_native", chainId: 1 }, "nope", "1", from)).toThrow();
    expect(hexChainId(8453)).toBe("0x2105");
  });
});

function provider(handlers: Record<string, (params: unknown) => unknown>) {
  const calls: { method: string; params?: unknown }[] = [];
  return {
    calls,
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      calls.push({ method, params });
      const h = handlers[method];
      if (!h) throw Object.assign(new Error("unsupported"), { code: 4200 });
      return h(params);
    },
  };
}

describe("EIP-1193 helpers", () => {
  it("requests the account and maps rejections", async () => {
    expect(
      await requestAccount(provider({ eth_requestAccounts: () => ["0x42e06263bb5346ae6421ab1ec1019824e7b284e1"] })),
    ).toBe("0x42e06263bb5346ae6421ab1ec1019824e7b284e1");
    await expect(requestAccount(provider({ eth_requestAccounts: () => [] }))).rejects.toThrow("no account");
    const reject = provider({
      eth_requestAccounts: () => {
        throw Object.assign(new Error("no"), { code: 4001 });
      },
    });
    await expect(requestAccount(reject)).rejects.toBeInstanceOf(WalletRejected);
  });

  it("switches chains, adding unknown ones", async () => {
    let chain = "0x1";
    const p = provider({
      eth_chainId: () => chain,
      wallet_switchEthereumChain: () => {
        throw Object.assign(new Error("unknown chain"), { code: 4902 });
      },
      wallet_addEthereumChain: (params) => {
        chain = (params as { chainId: string }[])[0]?.chainId as string;
        return null;
      },
    });
    await ensureChain(p, "eip155:8453");
    expect(p.calls.map((c) => c.method)).toEqual([
      "eth_chainId",
      "wallet_switchEthereumChain",
      "wallet_addEthereumChain",
      "eth_chainId",
    ]);
    await ensureChain(p, "eip155:8453");
    await expect(ensureChain(p, "near:mainnet")).rejects.toThrow();
    const stuck = provider({ eth_chainId: () => "0x1", wallet_switchEthereumChain: () => null });
    await expect(ensureChain(stuck, "eip155:8453")).rejects.toThrow("Switch your wallet");
    const other = provider({
      eth_chainId: () => "0x1",
      wallet_switchEthereumChain: () => {
        throw Object.assign(new Error("boom"), { code: -32000 });
      },
    });
    await expect(ensureChain(other, "eip155:8453")).rejects.toThrow("boom");
  });

  it("validates transaction hashes and signatures returned by wallets", async () => {
    const hash = `0x${"ab".repeat(32)}`;
    expect(
      await sendTransaction(provider({ eth_sendTransaction: () => hash }), { from: "0x1", to: "0x2", value: "0x0" }),
    ).toBe(hash);
    await expect(
      sendTransaction(provider({ eth_sendTransaction: () => "0x12" }), { from: "0x1", to: "0x2", value: "0x0" }),
    ).rejects.toThrow();
    const sig = `0x${"11".repeat(65)}`;
    const p = provider({ personal_sign: () => sig });
    expect(await personalSign(p, "hé", "0xabc")).toBe(sig);
    expect(p.calls[0]?.params).toEqual(["0x68c3a9", "0xabc"]);
    await expect(personalSign(provider({ personal_sign: () => "0x1" }), "x", "0xabc")).rejects.toThrow();
  });

  it("accepts only data: wallet icons", () => {
    expect(safeIcon("data:image/svg+xml;base64,AAA")).not.toBeNull();
    expect(safeIcon("https://evil.example/icon.png")).toBeNull();
    expect(safeIcon("javascript:alert(1)")).toBeNull();
  });
});

describe("NEAR deposits", () => {
  const base = {
    depositAddress: "a".repeat(64),
    amountIn: "2000000",
    memo: null,
    storageMin: "1250000000000000000000",
  };
  it("registers storage when needed, then ft_transfer with 1 yocto", () => {
    const [tx] = nearDepositTransactions({
      ...base,
      asset: { kind: "near_nep141", token: "usdc.near" },
      registered: false,
    });
    expect(tx?.receiverId).toBe("usdc.near");
    expect(tx?.actions.map((a) => a.params.methodName)).toEqual(["storage_deposit", "ft_transfer"]);
    expect(tx?.actions[0]?.params.deposit).toBe(base.storageMin);
    expect(tx?.actions[1]?.params).toEqual({
      methodName: "ft_transfer",
      args: { receiver_id: base.depositAddress, amount: "2000000" },
      gas: "30000000000000",
      deposit: "1",
    });
  });
  it("skips storage when registered and passes the memo", () => {
    const [tx] = nearDepositTransactions({
      ...base,
      memo: "m-1",
      asset: { kind: "near_nep141", token: "usdc.near" },
      registered: true,
    });
    expect(tx?.actions.map((a) => a.params.methodName)).toEqual(["ft_transfer"]);
    expect(tx?.actions[0]?.params.args).toMatchObject({ memo: "m-1" });
  });
  it("wraps native NEAR first for wNEAR", () => {
    const [tx] = nearDepositTransactions({
      ...base,
      asset: { kind: "near_wrap", token: "wrap.near" },
      registered: true,
    });
    expect(tx?.actions.map((a) => [a.params.methodName, a.params.deposit])).toEqual([
      ["near_deposit", "2000000"],
      ["ft_transfer", "1"],
    ]);
    expect(() =>
      nearDepositTransactions({
        ...base,
        amountIn: "0",
        asset: { kind: "near_wrap", token: "wrap.near" },
        registered: true,
      }),
    ).toThrow();
  });
  it("extracts the deposit tx hash from wallet outcomes", () => {
    const h = "9XKGkKdV8ZP2t5cE6z6V8S1Ud6eS3wQ7t2Fq9KcYQm1e";
    expect(depositTxHash([{ transaction: { hash: "x" } }, { transaction: { hash: h } }])).toBe(h);
    expect(depositTxHash({ transaction_outcome: { id: h } })).toBe(h);
    expect(() => depositTxHash([])).toThrow();
  });
});

describe("NEAR RPC views", () => {
  const rpc = (result: unknown, ok = true) =>
    (async () =>
      new Response(
        JSON.stringify(
          ok
            ? { result: { result: Array.from(new TextEncoder().encode(JSON.stringify(result))) } }
            : { error: { name: "x" } },
        ),
        {
          status: 200,
        },
      )) as unknown as typeof fetch;
  it("decodes view results", async () => {
    expect(await storageBalanceOf("https://rpc", "t.near", "a.near", rpc(null))).toBeNull();
    expect(await storageBalanceBounds("https://rpc", "t.near", rpc({ min: "1", max: null }))).toEqual({
      min: "1",
      max: null,
    });
    expect(await currentSalt("https://rpc", "intents.near", rpc("252812b3"))).toBe("252812b3");
    await expect(currentSalt("https://rpc", "intents.near", rpc("zz"))).rejects.toThrow();
    await expect(viewFunction("https://rpc", "t", "m", {}, rpc(null, false))).rejects.toThrow();
    const down = (async () => new Response("", { status: 502 })) as unknown as typeof fetch;
    await expect(viewFunction("https://rpc", "t", "m", {}, down)).rejects.toThrow("502");
  });
});
