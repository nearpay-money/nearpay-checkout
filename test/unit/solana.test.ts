/**
 * Solana wallet path (lld/checkout-and-js.md §11) against the spec 0.4.0 vectors: instructions byte for
 * byte (program ids, account metas, data), ATA derivation, the SPL asset id rule, the recipe's fail-closed
 * rules, the legacy message encoding, and the Solana Pay / BIP-21 manual-path QR.
 */
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, resolveConfig } from "../../build/config";
import { initialState, type Option, type State } from "../../src/app/machine";
import { PHASE_SCREENS, screenFor, TX_FAILED } from "../../src/app/screens";
import { isSolanaWalletOption, payableOptions } from "../../src/features/asset-picker/options";
import { BTC_ASSET_ID, paymentUri } from "../../src/features/deposit-instructions/qr";
import {
  BITCOIN_MAINNET,
  bip21Uri,
  formatBaseUnits,
  parseOmftAssetId,
  SOLANA_MAINNET,
  solanaPayUri,
} from "../../src/lib/spec-gap-0.4.0/chains";
import {
  associatedTokenAddress,
  compileLegacyMessage,
  type Instruction,
  isSolanaAddress,
  pubkeyBytes,
  solanaInstructions,
  solanaPaymentTransaction,
  solanaRecipe,
  splAssetId,
  systemTransfer,
  transferChecked,
  unsignedTransaction,
} from "../../src/wallets/solana/tx";
import chains from "../fixtures/spec-0.4.0/chains-solana-bitcoin.json";
import v from "../fixtures/spec-0.4.0/solana-transfer.json";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const asVector = (ixs: Instruction[]) =>
  ixs.map((ix) => ({
    program_id: ix.programId,
    accounts: ix.accounts.map((a) => ({ pubkey: a.pubkey, is_signer: a.isSigner, is_writable: a.isWritable })),
    data_hex: hex(ix.data),
  }));
const strip = (ixs: typeof v.sol.instructions) => ixs.map(({ name: _n, ...rest }) => rest);

type Att = Parameters<typeof solanaRecipe>[0];
function att(over: { asset?: Att["asset"] | null; memo?: string | null; chain?: string; amount?: string } = {}): Att {
  const asset =
    over.asset === null
      ? undefined
      : (over.asset ?? {
          asset_id: v.spl.asset_id,
          symbol: "USDC",
          decimals: 6,
          token: { standard: "spl", address: v.spl.mint },
        });
  return {
    kind: "route_quote",
    deposit: {
      address: v.inputs.deposit_address,
      memo: over.memo ?? null,
      chain: over.chain ?? SOLANA_MAINNET,
      origin_asset_id: asset?.asset_id ?? v.spl.asset_id,
      amount_in: over.amount ?? v.spl.amount_in,
      deadline: "2026-11-09T12:00:00.000Z",
    },
    ...(asset ? { asset } : {}),
  } as Att;
}
const SOL_ASSET = {
  asset_id: v.sol.asset_id,
  symbol: "SOL",
  decimals: 9,
  token: { standard: "native", address: null },
};

describe("Solana instructions (solana-transfer.json)", () => {
  it("SOL: one System.Transfer exactly as the vector", () => {
    const ixs = solanaInstructions(
      { kind: "sol", deposit: v.inputs.deposit_address, lamports: v.sol.amount_in },
      v.inputs.payer,
    );
    expect(asVector(ixs)).toEqual(strip(v.sol.instructions));
  });
  it("SPL: CreateIdempotent + TransferChecked exactly as the vector", () => {
    const r = solanaRecipe(att());
    expect(r).toEqual({
      ok: true,
      recipe: {
        kind: "spl",
        deposit: v.inputs.deposit_address,
        mint: v.spl.mint,
        decimals: 6,
        amount: v.spl.amount_in,
      },
    });
    if (!r?.ok) throw new Error("recipe");
    expect(asVector(solanaInstructions(r.recipe, v.inputs.payer))).toEqual(strip(v.spl.instructions));
  });
  it("derives ATAs and bumps", () => {
    expect(associatedTokenAddress(v.inputs.payer, v.spl.mint)).toEqual(v.spl.payer_ata);
    expect(associatedTokenAddress(v.inputs.deposit_address, v.spl.mint)).toEqual(v.spl.deposit_ata);
  });
  it("reproduces every Solana omft asset id from its mint", () => {
    for (const a of chains.assets.filter((x) => x.token.standard === "spl")) {
      expect(splAssetId(a.token.address as string)).toBe(a.asset_id);
    }
  });
  it("rejects out-of-range amounts and bad addresses", () => {
    expect(() => systemTransfer(v.inputs.payer, v.inputs.deposit_address, "0")).toThrow();
    expect(() => systemTransfer(v.inputs.payer, v.inputs.deposit_address, "18446744073709551616")).toThrow();
    expect(() => transferChecked(v.inputs.payer, v.spl.mint, v.inputs.payer, v.inputs.payer, "1", 256)).toThrow();
    expect(() => pubkeyBytes("0xnotbase58")).toThrow();
    expect(() => pubkeyBytes("1111")).toThrow();
    expect(isSolanaAddress(v.spl.mint)).toBe(true);
    expect(isSolanaAddress("abc")).toBe(false);
  });
});

describe("solanaRecipe (fail closed)", () => {
  it("SOL needs the native token and 9 decimals", () => {
    expect(solanaRecipe(att({ asset: SOL_ASSET as Att["asset"], amount: v.sol.amount_in }))).toEqual({
      ok: true,
      recipe: { kind: "sol", deposit: v.inputs.deposit_address, lamports: v.sol.amount_in },
    });
    expect(solanaRecipe(att({ asset: { ...SOL_ASSET, decimals: 8 } as Att["asset"] }))).toEqual({
      ok: false,
      reason: "token",
    });
    expect(
      solanaRecipe(att({ asset: { ...SOL_ASSET, token: { standard: "spl", address: v.spl.mint } } as Att["asset"] })),
    ).toEqual({ ok: false, reason: "token" });
  });
  it("memo present → manual path", () => {
    expect(solanaRecipe(att({ memo: "123" }))).toEqual({ ok: false, reason: "memo" });
  });
  it("no attested asset or no token → manual path", () => {
    expect(solanaRecipe(att({ asset: null }))).toEqual({ ok: false, reason: "no_asset" });
    const noToken = { asset_id: v.spl.asset_id, symbol: "USDC", decimals: 6 } as Att["asset"];
    expect(solanaRecipe(att({ asset: noToken }))).toEqual({ ok: false, reason: "token" });
    const other = {
      asset_id: v.spl.asset_id,
      symbol: "USDC",
      decimals: 6,
      token: { standard: "other", address: null },
    };
    expect(solanaRecipe(att({ asset: other as Att["asset"] }))).toEqual({ ok: false, reason: "token" });
  });
  it("a mint that does not reproduce the asset id is refused", () => {
    const usdt = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
    const wrong = { asset_id: v.spl.asset_id, symbol: "USDC", decimals: 6, token: { standard: "spl", address: usdt } };
    expect(solanaRecipe(att({ asset: wrong as Att["asset"] }))).toEqual({ ok: false, reason: "mint_mismatch" });
    const notOmft = {
      asset_id: "nep141:usdc.near",
      symbol: "USDC",
      decimals: 6,
      token: { standard: "spl", address: v.spl.mint },
    };
    expect(solanaRecipe(att({ asset: notOmft as Att["asset"] }))).toEqual({ ok: false, reason: "mint_mismatch" });
  });
  it("not a Solana route quote → null; bad deposit → manual", () => {
    expect(solanaRecipe(att({ chain: "eip155:8453" }))).toBeNull();
    expect(solanaRecipe({ ...att(), kind: "intents_transfer" } as Att)).toBeNull();
    const bad = att();
    expect(solanaRecipe({ ...bad, deposit: { ...bad.deposit, address: "0xabc" } } as Att)).toEqual({
      ok: false,
      reason: "token",
    });
  });
});

describe("legacy message", () => {
  it("orders keys (payer, writable, readonly) and encodes the SPL payment", () => {
    const r = solanaRecipe(att());
    if (!r?.ok) throw new Error("recipe");
    const msg = compileLegacyMessage(
      v.inputs.payer,
      solanaInstructions(r.recipe, v.inputs.payer),
      v.inputs.recent_blockhash,
    );
    // 1 signer, 0 readonly signed, 5 readonly unsigned (deposit owner, mint, system, token, ATA program).
    expect([...msg.slice(0, 3)]).toEqual([1, 0, 5]);
    expect(msg[3]).toBe(8);
    const keys = Array.from({ length: 8 }, (_, i) => bs58.encode(msg.slice(4 + 32 * i, 36 + 32 * i)));
    expect(keys[0]).toBe(v.inputs.payer);
    expect(keys.slice(1, 3).sort()).toEqual([v.spl.payer_ata.address, v.spl.deposit_ata.address].sort());
    expect(bs58.encode(msg.slice(4 + 32 * 8, 36 + 32 * 8))).toBe(v.inputs.recent_blockhash);
    const tx = solanaPaymentTransaction(r.recipe, v.inputs.payer, v.inputs.recent_blockhash);
    expect(tx[0]).toBe(1);
    expect(tx.slice(1, 65).every((b) => b === 0)).toBe(true);
    expect(hex(tx.slice(65))).toBe(hex(msg));
  });
  it("encodes the SOL transfer and compact lengths", () => {
    const msg = compileLegacyMessage(
      v.inputs.payer,
      [systemTransfer(v.inputs.payer, v.inputs.deposit_address, v.sol.amount_in)],
      v.inputs.recent_blockhash,
    );
    expect([...msg.slice(0, 4)]).toEqual([1, 0, 1, 3]);
    // program index 2, accounts [0, 1], 12 data bytes.
    expect(hex(msg.slice(-17))).toBe(`0202000${"1"}0c${v.sol.instructions[0]?.data_hex}`);
    const big = new Uint8Array(200);
    big[0] = 1;
    expect(unsignedTransaction(big).length).toBe(1 + 64 + 200);
  });
});

describe("manual path URIs", () => {
  it("formats base units exactly", () => {
    for (const c of chains.payment_uris.format_base_units)
      expect(formatBaseUnits(c.amount, c.decimals)).toBe(c.decimal);
    expect(() => formatBaseUnits("1.5", 6)).toThrow();
    expect(() => formatBaseUnits("1", -1)).toThrow();
  });
  it("BIP-21 and Solana Pay as the vectors", () => {
    for (const c of chains.payment_uris.bip21) expect(bip21Uri(c.address, c.amount_sats)).toBe(c.uri);
    for (const c of chains.payment_uris.solana_pay)
      expect(solanaPayUri(c.recipient, c.amount_base, c.decimals, c.spl_mint)).toBe(c.uri);
  });
  it("parses omft asset ids", () => {
    for (const c of chains.omft.cases) expect(parseOmftAssetId(c.asset_id)).toEqual(c.parsed);
  });
  it("QR: Solana Pay only with attested, reconciled data; BIP-21 for native BTC", () => {
    expect(paymentUri(att())).toBe(chains.payment_uris.solana_pay[0]?.uri);
    expect(paymentUri(att({ asset: SOL_ASSET as Att["asset"], amount: "1500000000" }))).toBe(
      chains.payment_uris.solana_pay[1]?.uri,
    );
    expect(paymentUri(att({ memo: "1" }))).toBeNull();
    expect(paymentUri(att({ asset: null }))).toBeNull();
    const wrongMint = {
      asset_id: v.spl.asset_id,
      symbol: "USDC",
      decimals: 6,
      token: { standard: "spl", address: v.inputs.payer },
    };
    expect(paymentUri(att({ asset: wrongMint as Att["asset"] }))).toBeNull();
    expect(paymentUri(att({ asset: { ...SOL_ASSET, token: null } as Att["asset"] }))).toBeNull();
    const btc = (asset: Att["asset"] | undefined, origin = BTC_ASSET_ID) =>
      ({
        deposit: {
          address: "bc1qpct5sxzppv204tth290uen85nqkhzw9sq5m0ku",
          memo: null,
          chain: BITCOIN_MAINNET,
          origin_asset_id: origin,
          amount_in: "123450",
          deadline: "2026-11-09T12:00:00.000Z",
        },
        ...(asset ? { asset } : {}),
      }) as Att;
    expect(paymentUri(btc(undefined))).toBe(chains.payment_uris.bip21[0]?.uri);
    expect(paymentUri(btc({ asset_id: BTC_ASSET_ID, symbol: "BTC", decimals: 7 } as Att["asset"]))).toBeNull();
    expect(paymentUri(btc(undefined, "nep141:other.omft.near"))).toBeNull();
    expect(paymentUri({ deposit: { ...btc(undefined).deposit, chain: "eip155:1" } } as Att)).toBeNull();
    expect(paymentUri({} as Att)).toBeNull();
  });
});

describe("Solana in the option list, screens and build config", () => {
  const opt = (method: string, asset: string, chain: string) =>
    ({
      method,
      origin_asset_id: asset,
      chain,
      symbol: "X",
      decimals: 6,
      estimated_amount_in: "1",
      route_class: "stable_pair",
      min_deadline_s: 300,
      available: true,
      reason: null,
    }) as unknown as Option;
  it("Solana wallets see Solana SOL/SPL route quotes only", () => {
    const all = [
      opt("route_quote", v.spl.asset_id, SOLANA_MAINNET),
      opt("route_quote", v.sol.asset_id, SOLANA_MAINNET),
      opt("route_quote", "nep141:eth.omft.near", SOLANA_MAINNET),
      opt("route_quote", "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", "eip155:8453"),
      opt("intents_transfer", "nep141:usdc.near", "near:mainnet"),
    ];
    expect(payableOptions(all, "wallet", "solana").map((o) => o.origin_asset_id)).toEqual([
      v.spl.asset_id,
      v.sol.asset_id,
    ]);
    expect(payableOptions(all, "wallet", "evm").some((o) => o.chain === SOLANA_MAINNET)).toBe(false);
    expect(isSolanaWalletOption(opt("intents_transfer", v.spl.asset_id, SOLANA_MAINNET))).toBe(false);
  });
  it("a Solana send error renders 'Transaction failed in your wallet'", () => {
    expect(PHASE_SCREENS.pay_wallet).toContain("tx_failed");
    const s = {
      ...initialState,
      phase: "pay_wallet",
      verified: {} as State["verified"],
      session: { livemode: true } as State["session"],
      error: { code: TX_FAILED },
    } as State;
    expect(screenFor(s, { manualForm: false, busy: false, slow: false, totalChanged: false })).toBe("tx_failed");
  });
  it("adds the Solana RPC origin to connect-src and validates it", () => {
    const keys = JSON.stringify([{ kid: "k1", public_key: "LHE3Fv7ETKuSmfJWAEBI9iPLlmY5mnePtHvXygDK9GA" }]);
    const c = resolveConfig({ VITE_SENTINEL_KEYS: keys }, process.cwd(), "production");
    expect(c.solanaRpcUrl).toBe("https://api.mainnet-beta.solana.com");
    expect(contentSecurityPolicy(c)).toMatch(/connect-src [^;]*https:\/\/api\.mainnet-beta\.solana\.com/);
    const custom = resolveConfig(
      { VITE_SENTINEL_KEYS: keys, VITE_SOLANA_RPC_URL: "https://sol.example/rpc" },
      process.cwd(),
      "production",
    );
    expect(contentSecurityPolicy(custom)).toContain("https://sol.example");
    expect(() =>
      resolveConfig({ VITE_SENTINEL_KEYS: keys, VITE_SOLANA_RPC_URL: "/rpc" }, process.cwd(), "production"),
    ).toThrow();
    expect(() =>
      resolveConfig(
        { VITE_SENTINEL_KEYS: keys, VITE_SOLANA_RPC_URL: "http://evil.example" },
        process.cwd(),
        "production",
      ),
    ).toThrow(/https/);
  });
});

describe("recipe freshness before signing", () => {
  it("sameRecipe compares every field and kind", async () => {
    const { sameRecipe } = await import("../../src/app/useCheckout");
    const spl = { kind: "spl", deposit: "D", mint: "M", decimals: 6, amount: "1" } as const;
    const sol = { kind: "sol", deposit: "D", lamports: "1" } as const;
    expect(sameRecipe(spl, { ...spl })).toBe(true);
    expect(sameRecipe(spl, { ...spl, amount: "2" })).toBe(false);
    expect(sameRecipe(spl, { ...spl, mint: "N" })).toBe(false);
    expect(sameRecipe(spl, { ...spl, decimals: 9 })).toBe(false);
    expect(sameRecipe(spl, { ...spl, deposit: "E" })).toBe(false);
    expect(sameRecipe(sol, { ...sol })).toBe(true);
    expect(sameRecipe(sol, { ...sol, lamports: "2" })).toBe(false);
    expect(sameRecipe(sol, spl)).toBe(false);
  });
});
