/**
 * Asset id shapes (spec 0.5.2 parseAssetId; incident 2026-11-11: 1Click's new `.omdep.near` ids): the wallet path
 * derives EVM recipes for omdep ids (incl. the `bnb` prefix of BNB Smart Chain) and Solana recipes / Solana Pay QRs for
 * omdep SPL ids (`sol-0x<hash20>`); bridge ids are never read as NEAR tokens.
 */
import vectors from "@nearpay-money/spec/test-vectors/asset-ids.json";
import { describe, expect, it } from "vitest";
import { paymentUri } from "../../src/features/deposit-instructions/qr";
import { walletAsset } from "../../src/lib/chains/chains";
import { solanaAssetOf, solanaRecipe, splMintMatches } from "../../src/wallets/solana/tx";

const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDT_BSC = "nep141:bnb-0x55d398326f99059ff775485246999027b3197955.omdep.near";
const PENGU = "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv";
const PENGU_ID = "nep141:sol-0xaad74c68eecfc9f8c5bdcea614f6167048c795ef.omdep.near";
const DEPOSIT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

describe("EVM wallet recipes from omdep ids", () => {
  it.each([
    [USDT_BSC, "eip155:56", { kind: "evm_erc20", chainId: 56, token: "0x55d398326f99059ff775485246999027b3197955" }],
    ["nep141:bnb.omdep.near", "eip155:56", { kind: "evm_native", chainId: 56 }],
    [
      "nep141:pol-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omdep.near",
      "eip155:137",
      { kind: "evm_erc20", chainId: 137 },
    ],
    ["nep141:avax-0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e.omdep.near", "eip155:43114", { kind: "evm_erc20" }],
    [
      "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      "eip155:8453",
      { kind: "evm_erc20", chainId: 8453 },
    ],
  ])("%s on %s", (id, chain, recipe) => expect(walletAsset(id, chain)).toMatchObject(recipe));

  it("a prefix of another chain derives nothing (fail closed) and a contradicting token disables the wallet path", () => {
    expect(walletAsset(USDT_BSC, "eip155:1")).toBeNull();
    expect(
      walletAsset(USDT_BSC, "eip155:56", { standard: "erc20", address: "0x0000000000000000000000000000000000000001" }),
    ).toBeNull();
  });

  it("bridge ids are never NEAR tokens; plain NEP-141 accounts are", () => {
    expect(walletAsset(USDT_BSC, "near:mainnet")).toBeNull();
    expect(walletAsset("nep141:eth.bridge.near", "near:mainnet")).toBeNull();
    expect(walletAsset("nep141:usdt.tether-token.near", "near:mainnet")).toEqual({
      kind: "near_nep141",
      token: "usdt.tether-token.near",
    });
    // listed on NEAR by 1Click with its own account as contract: paid through the typed token
    const strk = "nep141:strk-0xe646ef2a705bf5147ceffc8dfbcc7bee4946b8f7.omdep.near";
    expect(walletAsset(strk, "near:mainnet", { standard: "nep141", address: strk.slice(7) })).toEqual({
      kind: "near_nep141",
      token: strk.slice(7),
    });
  });
});

describe("Solana ids (omft, omdep, 1cs_v1)", () => {
  it("classifies native SOL and SPL tokens; nothing else", () => {
    expect(solanaAssetOf("nep141:sol.omft.near")).toEqual({ kind: "native" });
    expect(solanaAssetOf("nep141:sol.omdep.near")).toEqual({ kind: "native" });
    expect(solanaAssetOf(PENGU_ID)).toEqual({ kind: "spl", hash20: "aad74c68eecfc9f8c5bdcea614f6167048c795ef" });
    expect(solanaAssetOf(`1cs_v1:sol:spl:${PENGU}`)).toEqual({ kind: "spl", mint: PENGU });
    expect(solanaAssetOf(USDT_BSC)).toBeNull();
    expect(splMintMatches(PENGU_ID, PENGU)).toBe(true);
    expect(splMintMatches(`1cs_v1:sol:spl:${PENGU}`, PENGU)).toBe(true);
    expect(splMintMatches(PENGU_ID, DEPOSIT)).toBe(false);
  });

  const att = (assetId: string, mint: string) => ({
    kind: "route_quote" as const,
    deposit: {
      address: DEPOSIT,
      memo: null,
      chain: SOL,
      origin_asset_id: assetId,
      amount_in: "1500000",
      deadline: "2026-11-12T12:00:00.000Z",
    },
    asset: { asset_id: assetId, symbol: "PENGU", decimals: 6, token: { standard: "spl" as const, address: mint } },
  });

  it("an omdep SPL attestation gets a wallet recipe and a Solana Pay QR; a wrong mint gets neither", () => {
    expect(solanaRecipe(att(PENGU_ID, PENGU) as never)).toMatchObject({
      ok: true,
      recipe: { kind: "spl", mint: PENGU },
    });
    expect(paymentUri(att(PENGU_ID, PENGU) as never)).toBe(`solana:${DEPOSIT}?amount=1.5&spl-token=${PENGU}`);
    expect(solanaRecipe(att(PENGU_ID, DEPOSIT) as never)).toEqual({ ok: false, reason: "mint_mismatch" });
    expect(paymentUri(att(PENGU_ID, DEPOSIT) as never)).toBeNull();
  });
});

describe("spec asset-ids.json", () => {
  it("bridge ids on a chain checkout pays derive only on their own chain", () => {
    for (const c of vectors.cases as { asset_id: string; blockchain: string | null }[]) {
      if (c.blockchain === "bsc" && c.asset_id.startsWith("nep141:"))
        expect(walletAsset(c.asset_id, "eip155:56"), c.asset_id).not.toBeNull();
      if (c.blockchain === null) expect(walletAsset(c.asset_id, "near:mainnet"), c.asset_id).toBeNull();
    }
  });
});
