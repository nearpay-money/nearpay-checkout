/**
 * Stage 4 (lld/checkout-and-js.md §11): Solana wallets through the Wallet Standard, the SOL / SPL wallet
 * recipe from the verified attestation (memo null, classic Token program), the manual path's Solana Pay /
 * BIP-21 QR, and the unchanged rules (sentinel before any prompt, test mode never broadcasts).
 */
import bs58 from "bs58";
import { SOLANA_MAINNET } from "../../src/lib/spec-gap-0.4.0";
import { solanaPaymentTransaction } from "../../src/wallets/solana/tx";
import v from "../fixtures/spec-0.4.0/solana-transfer.json";
import { expect, test } from "./support/fixtures";
import type { MockNearPay } from "./support/mock-server";
import { injectSolanaWallet, SOL_PAYER, stubSolanaRpc } from "./support/wallets";

const BTC = "bip122:000000000019d6689c085ae165831e93";
const SPL = v.spl.asset_id;
const SOL = v.sol.asset_id;
const BLOCKHASH = v.inputs.recent_blockhash;

const option = (asset: string, chain: string, symbol: string, decimals: number, amount: string) => ({
  method: "route_quote",
  origin_asset_id: asset,
  chain,
  symbol,
  decimals,
  estimated_amount_in: amount,
  route_class: "stable_pair",
  min_deadline_s: 300,
  available: true,
  reason: null,
});
const OPTIONS = [
  option(SPL, SOLANA_MAINNET, "USDC", 6, v.spl.amount_in),
  option(SOL, SOLANA_MAINNET, "SOL", 9, v.sol.amount_in),
  option("nep141:btc.omft.near", BTC, "BTC", 8, "123450"),
];
const SPL_TOKEN = { standard: "spl", address: v.spl.mint };
const SOL_TOKEN = { standard: "native", address: null };

function solSession(mock: MockNearPay, live: boolean, extra: Parameters<MockNearPay["create"]>[1] = {}) {
  return mock.create({ livemode: live }, { options: OPTIONS, attestToken: SPL_TOKEN, autoSucceed: true, ...extra });
}

async function solCalls(page: import("@playwright/test").Page) {
  return page.evaluate(
    () => (window as unknown as { __solCalls: { method: string; tx?: number[]; chain?: string }[] }).__solCalls,
  );
}

test("SPL (live): Wallet Standard wallet signs CreateIdempotent + TransferChecked from the attestation", async ({
  page,
  mock,
}) => {
  await injectSolanaWallet(page);
  const rpc = await stubSolanaRpc(page);
  const s = solSession(mock, true);
  await page.goto(mock.url(s));
  await page.getByTestId("path-wallet").click();
  await page.getByTestId("sol-wallet-mock-phantom").click();
  await expect(page.getByTestId("connected-wallet")).toContainText("Mock Phantom");
  // Solana wallets see Solana route quotes only (no Intents transfer, no BTC).
  await expect(page.getByTestId(`option-route_quote-${SPL}`)).toBeVisible();
  await expect(page.getByTestId(`option-route_quote-nep141:btc.omft.near`)).toHaveCount(0);
  expect(mock.callsTo("listPaymentOptions")[0]?.headers).toBeDefined();
  await page.getByTestId(`option-route_quote-${SPL}`).click();
  await expect(page.locator(".np-checkout__merchant-name")).toHaveText("Acme GmbH");
  await expect(page.getByTestId("network-fee-note")).toContainText("about 0.00203928 SOL (Solana rent)");
  await page.getByTestId("wallet-send").click();
  await expect(page.getByTestId("succeeded")).toBeVisible();

  const created = mock.bodyOf("createPaymentAttempt");
  expect(created.refund_to).toBe(SOL_PAYER);
  const calls = await solCalls(page);
  expect(calls.map((c) => c.method)).toEqual(["connect", "signAndSendTransaction"]);
  expect(calls[1]?.chain).toBe("solana:mainnet");
  const expected = solanaPaymentTransaction(
    { kind: "spl", deposit: v.inputs.deposit_address, mint: v.spl.mint, decimals: 6, amount: v.spl.amount_in },
    SOL_PAYER,
    BLOCKHASH,
  );
  expect(calls[1]?.tx).toEqual(Array.from(expected));
  expect(mock.bodyOf("submitDepositTx")).toEqual({ tx_hash: bs58.encode(new Uint8Array(64).fill(7)) });
  expect(rpc).toEqual(["getAccountInfo", "getAccountInfo", "getMinimumBalanceForRentExemption", "getLatestBlockhash"]);
});

test("SOL (live): one System.Transfer, no token checks", async ({ page, mock }) => {
  await injectSolanaWallet(page);
  const rpc = await stubSolanaRpc(page);
  const s = solSession(mock, true, { attestToken: SOL_TOKEN, attestMeta: { symbol: "SOL", decimals: 9 } });
  await page.goto(mock.url(s));
  await page.getByTestId("path-wallet").click();
  await page.getByTestId("sol-wallet-mock-phantom").click();
  await page.getByTestId(`option-route_quote-${SOL}`).click();
  await expect(page.getByTestId("network-fee-note")).not.toContainText("rent");
  await page.getByTestId("wallet-send").click();
  await expect(page.getByTestId("succeeded")).toBeVisible();
  const tx = (await solCalls(page))[1]?.tx;
  expect(tx).toEqual(
    Array.from(
      solanaPaymentTransaction({ kind: "sol", deposit: v.inputs.deposit_address, lamports: v.sol.amount_in }, SOL_PAYER, BLOCKHASH),
    ),
  );
  expect(rpc).toEqual(["getLatestBlockhash"]);
});

test("Token-2022 mint → manual path only; 'Send from another wallet' opens it", async ({ page, mock }) => {
  await injectSolanaWallet(page);
  await stubSolanaRpc(page, { token2022: true });
  const s = solSession(mock, true);
  await page.goto(mock.url(s));
  await page.getByTestId("path-wallet").click();
  await page.getByTestId("sol-wallet-mock-phantom").click();
  await page.getByTestId(`option-route_quote-${SPL}`).click();
  await expect(page.getByTestId("solana-manual-only")).toContainText("Token-2022");
  await expect(page.getByTestId("wallet-send")).toHaveCount(0);
  await page.getByTestId("use-manual").click();
  await expect(page.getByTestId("asset-picker")).toBeVisible();
  expect((await solCalls(page)).map((c) => c.method)).toEqual(["connect"]);
});

test("a memo or an unreconciled mint → manual path only, the wallet is never asked", async ({ page, mock }) => {
  await injectSolanaWallet(page);
  await stubSolanaRpc(page);
  const s = solSession(mock, true, { memo: "4242" });
  await page.goto(mock.url(s));
  await page.getByTestId("path-wallet").click();
  await page.getByTestId("sol-wallet-mock-phantom").click();
  await page.getByTestId(`option-route_quote-${SPL}`).click();
  await expect(page.getByTestId("solana-manual-only")).toContainText("memo");

  const s2 = solSession(mock, true, { attestToken: { standard: "spl", address: SOL_PAYER } });
  await page.goto(mock.url(s2));
  await page.getByTestId("path-wallet").click();
  await page.getByTestId("sol-wallet-mock-phantom").click();
  await page.getByTestId(`option-route_quote-${SPL}`).click();
  await expect(page.getByTestId("solana-manual-only")).toContainText("mint doesn't match");
  expect((await solCalls(page)).filter((c) => c.method === "signAndSendTransaction")).toEqual([]);
});

test("rejection → Payment not approved; send error → Transaction failed in your wallet + retry", async ({
  page,
  mock,
}) => {
  await injectSolanaWallet(page, { reject: "send" });
  await stubSolanaRpc(page);
  const s = solSession(mock, true);
  await page.goto(mock.url(s));
  await page.getByTestId("path-wallet").click();
  await page.getByTestId("sol-wallet-mock-phantom").click();
  await page.getByTestId(`option-route_quote-${SPL}`).click();
  await page.getByTestId("wallet-send").click();
  await expect(page.getByTestId("wallet-pay")).toContainText("Payment not approved");

  await page.unrouteAll({ behavior: "ignoreErrors" });
  const page2 = await page.context().newPage();
  await injectSolanaWallet(page2, { sendError: "Transaction simulation failed: blockhash not found" });
  await stubSolanaRpc(page2);
  const { stubExternal } = await import("./support/fixtures");
  await stubExternal(page2);
  const s2 = solSession(mock, true);
  await page2.goto(mock.url(s2));
  await page2.getByTestId("path-wallet").click();
  await page2.getByTestId("sol-wallet-mock-phantom").click();
  await page2.getByTestId(`option-route_quote-${SPL}`).click();
  await page2.getByTestId("wallet-send").click();
  await expect(page2.getByTestId("wallet-pay")).toContainText("Transaction failed in your wallet");
  await expect(page2.getByTestId("wallet-pay")).toContainText("blockhash not found");
  await page2.getByTestId("try-again").click();
  await expect(page2.getByTestId("wallet-send")).toBeVisible();
  expect(mock.callsTo("submitDepositTx")).toEqual([]);
  await page2.close();
});

test("Solana RPC down → retry, no prompt", async ({ page, mock }) => {
  await injectSolanaWallet(page);
  await stubSolanaRpc(page, { down: true });
  const s = solSession(mock, true);
  await page.goto(mock.url(s));
  await page.getByTestId("path-wallet").click();
  await page.getByTestId("sol-wallet-mock-phantom").click();
  await page.getByTestId(`option-route_quote-${SPL}`).click();
  await expect(page.getByTestId("solana-rpc-error")).toBeVisible();
  await expect(page.getByTestId("wallet-send")).toHaveCount(0);
  await page.unroute("https://api.mainnet-beta.solana.com/**");
  await stubSolanaRpc(page);
  await page.getByTestId("solana-retry").click();
  await expect(page.getByTestId("wallet-send")).toBeEnabled();
});

test("test mode never broadcasts from a Solana wallet: Simulate payment", async ({ page, mock }) => {
  await injectSolanaWallet(page);
  const rpc = await stubSolanaRpc(page);
  const s = solSession(mock, false);
  await page.goto(mock.url(s));
  await page.getByTestId("path-wallet").click();
  await page.getByTestId("sol-wallet-mock-phantom").click();
  await page.getByTestId(`option-route_quote-${SPL}`).click();
  await expect(page.getByTestId("wallet-send")).toHaveCount(0);
  await page.getByTestId("simulate").click();
  await expect(page.getByTestId("succeeded")).toBeVisible();
  expect((await solCalls(page)).map((c) => c.method)).toEqual(["connect"]);
  expect(rpc).toEqual([]);
});

test("manual path: Solana Pay QR for SPL (with the reconciled mint) and BIP-21 for Bitcoin", async ({ page, mock }) => {
  const s = solSession(mock, true, { autoSucceed: false });
  await page.goto(mock.url(s));
  await page.getByTestId("path-manual").click();
  await page.getByTestId(`option-route_quote-${SPL}`).click();
  await page.getByTestId("refund-address").fill("0xnot-solana");
  await page.getByTestId("continue").click();
  await expect(page.getByTestId("refund-error")).toBeVisible();
  await page.getByTestId("refund-address").fill(SOL_PAYER);
  await page.getByTestId("continue").click();
  await expect(page.getByTestId("qr")).toHaveCount(0);
  await page.getByTestId("confirm-network").check();
  await expect(page.getByTestId("qr")).toHaveAttribute(
    "data-value",
    `solana:${v.inputs.deposit_address}?amount=25.012345&spl-token=${v.spl.mint}`,
  );

  const b = mock.create(
    { livemode: true },
    { options: OPTIONS, attestToken: SOL_TOKEN, attestMeta: { symbol: "BTC", decimals: 8 } },
  );
  await page.goto(mock.url(b));
  await page.getByTestId("path-manual").click();
  await page.getByTestId("option-route_quote-nep141:btc.omft.near").click();
  await page.getByTestId("refund-address").fill("bc1pzkakv8d86xwnrvzx262umfvz04dxjeegc4lez8aqdlx50zjfsr5qrjf5pr");
  await page.getByTestId("continue").click();
  await page.getByTestId("confirm-network").check();
  await expect(page.getByTestId("qr")).toHaveAttribute(
    "data-value",
    "bitcoin:bc1qpct5sxzppv204tth290uen85nqkhzw9sq5m0ku?amount=0.0012345",
  );
});
