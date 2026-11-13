import { MultiPayload } from "@nearpay-money/spec";
import { USDC_BASE, USDC_NEAR } from "../support/sessions";
import { expect, test } from "./support/fixtures";
import { choose } from "./support/pay";
import { injectEvmWallet, injectNearWallet, stubNearRpc } from "./support/wallets";

const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
/** Read-only EVM provider methods (no wallet prompt). */
const READS = new Set([
  "eth_chainId",
  "eth_call",
  "eth_getBalance",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_getBlockByNumber",
  "eth_maxPriorityFeePerGas",
]);
const DEPOSIT = "0x76b4c56085ed136a8744d52be956396624a730e8";

test("EVM wallet (live): switches to Base and sends the attested ERC-20 transfer", async ({ page, mock }) => {
  await injectEvmWallet(page, { chainId: "0x1" });
  const s = mock.create({ livemode: true }, { autoSucceed: true });
  await page.goto(mock.url(s));
  await expect(page.getByTestId("test-banner")).toHaveCount(0);
  await page.getByTestId("path-wallet").click();
  await page.getByTestId("evm-wallet-test.mockwallet").click();
  await expect(page.getByTestId("connected-wallet")).toContainText("Mock Wallet");
  // EVM wallets see EVM routes and the Intents transfer, never NEAR deposits.
  await page.getByTestId("network-picker-trigger").click();
  await expect(page.getByTestId("network-near:mainnet")).toHaveCount(0);
  await expect(page.getByTestId("network-intents")).toBeVisible();
  await page.keyboard.press("Escape");
  await choose(page, "route_quote", USDC_BASE);
  await expect(page.getByTestId("refund-address")).toHaveCount(0);
  await expect(page.locator(".np-checkout__merchant-name")).toHaveText("Acme GmbH");
  await expect(page.getByTestId("wallet-pay")).toContainText("Your wallet will switch to Base.");
  await page.getByTestId("wallet-send").click();
  await expect(page.getByTestId("succeeded")).toBeVisible();

  const created = mock.callsTo("createPaymentAttempt")[0]?.body as Record<string, string>;
  expect(created.refund_to).toBe("0x42E06263bb5346ae6421aB1Ec1019824e7B284E1");
  const calls =
    (await page.evaluate(
      () => (window as unknown as { __evmCalls: { method: string; params?: unknown[] }[] }).__evmCalls,
    )) ?? [];
  // Prompts and writes only (balance and fee reads are read-only provider calls): connect, switch, send.
  expect(calls.map((c) => c.method).filter((m) => !READS.has(m))).toEqual([
    "eth_requestAccounts",
    "wallet_switchEthereumChain",
    "eth_sendTransaction",
  ]);
  // The wallet was on Ethereum: no balances read there for Base (the picker offered a switch instead).
  expect(calls.some((c) => c.method === "eth_call")).toBe(false);
  const tx = calls.at(-1)?.params?.[0] as Record<string, string>;
  expect(tx).toEqual({
    from: "0x42E06263bb5346ae6421aB1Ec1019824e7B284E1",
    to: TOKEN,
    value: "0x0",
    data: `0xa9059cbb${DEPOSIT.slice(2).padStart(64, "0")}${(2005013).toString(16).padStart(64, "0")}`,
  });
  expect(mock.callsTo("submitDepositTx")[0]?.body).toEqual({ tx_hash: `0x${"ab".repeat(32)}` });
  await page.waitForURL(/shop\.example\/thanks\?session_id=/);
});

test("EVM wallet in test mode never broadcasts: simulate instead", async ({ page, mock }) => {
  await injectEvmWallet(page, { chainId: "0x2105" });
  const s = mock.create({}, { autoSucceed: true });
  await page.goto(mock.url(s));
  await page.getByTestId("path-wallet").click();
  await page.getByTestId("evm-wallet-test.mockwallet").click();
  await choose(page, "route_quote", USDC_BASE);
  await expect(page.getByTestId("wallet-send")).toHaveCount(0);
  await page.getByTestId("simulate").click();
  await expect(page.getByTestId("succeeded")).toBeVisible();
  const calls = await page.evaluate(() =>
    (window as unknown as { __evmCalls: { method: string }[] }).__evmCalls.map((c) => c.method),
  );
  expect(calls).toEqual(["eth_requestAccounts"]);
  expect(mock.callsTo("simulateDeposit")).toHaveLength(1);
});

test("a rejected wallet connection shows a message and stays on wallet choice", async ({ page, mock }) => {
  await injectEvmWallet(page, { reject: true });
  const s = mock.create();
  await page.goto(mock.url(s));
  await page.getByTestId("path-wallet").click();
  await page.getByTestId("evm-wallet-test.mockwallet").click();
  await expect(page.getByTestId("wallet-connect")).toContainText("The request was rejected in your wallet.");
  await page.getByTestId("back").click();
  await expect(page.getByTestId("choose-path")).toBeVisible();
});

test("no wallets: EVM list empty, NEAR unavailable without the CSP nonce", async ({ page, mock }) => {
  const s = mock.create();
  await page.goto(mock.url(s));
  await page.getByTestId("path-wallet").click();
  await expect(page.getByTestId("no-evm-wallet")).toBeVisible();
  await expect(page.getByTestId("near-unavailable")).toBeVisible();
});

test("NEAR wallet (live): registers storage and ft_transfers the attested amount", async ({ page, mock }) => {
  await injectNearWallet(page);
  const rpc = await stubNearRpc(page, false);
  const s = mock.create({ livemode: true }, { autoSucceed: true });
  await page.goto(mock.url(s));
  await page.getByTestId("path-wallet").click();
  await page.getByTestId("near-connect").click();
  await expect(page.getByTestId("connected-wallet")).toContainText("payer.near");
  await page.getByTestId("network-picker-trigger").click();
  await expect(page.getByTestId("network-eip155:8453")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await choose(page, "route_quote", USDC_NEAR);
  await expect(page.locator(".np-checkout__merchant-name")).toHaveText("Acme GmbH");
  await page.getByTestId("wallet-send").click();
  await expect(page.getByTestId("succeeded")).toBeVisible();
  // Picker balance + network-fee pre-check reads, then the storage registration of the transfer.
  expect(new Set(rpc)).toEqual(
    new Set(["ft_balance_of", "storage_balance_of", "storage_balance_bounds", "view_account", "gas_price"]),
  );
  const calls = await page.evaluate(
    () => (window as unknown as { __nearCalls: { method: string; params: unknown }[] }).__nearCalls,
  );
  const [tx] = (calls[0] as { params: unknown }).params as {
    receiverId: string;
    actions: { params: { methodName: string; args: Record<string, unknown>; deposit: string } }[];
  }[];
  expect(tx?.receiverId).toBe(USDC_NEAR.slice(7));
  expect(tx?.actions.map((a) => a.params.methodName)).toEqual(["storage_deposit", "ft_transfer"]);
  expect(tx?.actions[1]?.params.args).toEqual({ receiver_id: "f".repeat(64), amount: "2003000" });
  expect(mock.callsTo("submitDepositTx")[0]?.body).toEqual({ tx_hash: "9XKGkKdV8ZP2t5cE6z6V8S1Ud6eS3wQ7t2Fq9KcYQm1e" });
  expect(mock.bodyOf("createPaymentAttempt").refund_to).toBe("payer.near");
});

test("NEAR Intents balance (live): signs the attested requirement with NEP-413", async ({ page, mock }) => {
  await injectNearWallet(page);
  const rpc = await stubNearRpc(page);
  const s = mock.create({ livemode: true }, { autoSucceed: true });
  await page.goto(mock.url(s));
  await page.getByTestId("path-wallet").click();
  await page.getByTestId("near-connect").click();
  await choose(page, "intents_transfer", USDC_NEAR);
  await expect(page.getByTestId("wallet-pay")).toContainText("Pay 2.006 USDC");
  await page.getByTestId("wallet-send").click();
  await expect(page.getByTestId("succeeded")).toBeVisible();
  // Balances for the picker, then the Verifier salt; an Intents transfer needs no gas (no fee pre-check).
  expect(rpc.filter((m) => !m.endsWith("_balance_of") && m !== "view_account")).toEqual(["current_salt"]);
  expect(mock.bodyOf("createPaymentAttempt").payer_wallet).toBe("payer.near");
  const body = mock.callsTo("submitSignedIntent")[0]?.body as { signed: unknown };
  const signed = MultiPayload.parse(body.signed);
  expect(signed.standard).toBe("nep413");
  if (signed.standard !== "nep413") return;
  expect(Buffer.from(signed.payload.nonce, "base64").subarray(0, 4).toString("hex")).toBe("252812b3");
  const msg = JSON.parse(signed.payload.message) as {
    signer_id: string;
    intents: { receiver_id: string; memo: string; tokens: Record<string, string> }[];
  };
  expect(msg.signer_id).toBe("payer.near");
  expect(msg.intents.map((i) => [i.receiver_id, i.tokens[USDC_NEAR], i.memo])).toEqual([
    ["merchant.near", "2000000", "np1:AQDxa2L6a5d8egVC7YP85UgtUCYp3cUotS6S3EsGcF7h"],
    ["treasury.nearpay.near", "6000", "np1:AQDxa2L6a5d8egVC7YP85UgtUCYp3cUotS6S3EsGcF7h"],
  ]);
});

test("EVM Intents balance (live): ERC-191 personal_sign from the eth-implicit account", async ({ page, mock }) => {
  await injectEvmWallet(page);
  await stubNearRpc(page);
  const s = mock.create({ livemode: true }, { autoSucceed: true });
  await page.goto(mock.url(s));
  await page.getByTestId("path-wallet").click();
  await page.getByTestId("evm-wallet-test.mockwallet").click();
  await choose(page, "intents_transfer", USDC_NEAR);
  await page.getByTestId("wallet-send").click();
  await expect(page.getByTestId("succeeded")).toBeVisible();
  expect(mock.bodyOf("createPaymentAttempt").payer_wallet).toBe("0x42e06263bb5346ae6421ab1ec1019824e7b284e1");
  const signed = MultiPayload.parse(mock.bodyOf<{ signed: unknown }>("submitSignedIntent").signed);
  expect(signed.standard).toBe("erc191");
  if (signed.standard === "erc191") expect(JSON.parse(signed.payload).verifying_contract).toBe("intents.near");
});

test("a tampered Intents requirement is refused before any signature is requested", async ({ page, mock }) => {
  await injectNearWallet(page);
  // Stubbed like the other NEAR tests: without it the picker reads payer.near's real balances from a public RPC
  // whenever the machine has network access, finds none, and hides the token this test picks.
  await stubNearRpc(page);
  const s = mock.create({ livemode: true }, { sentinel: "rogue_key" });
  await page.goto(mock.url(s));
  await page.getByTestId("path-wallet").click();
  await page.getByTestId("near-connect").click();
  await choose(page, "intents_transfer", USDC_NEAR);
  await expect(page.getByTestId("verify-failed")).toBeVisible();
  await expect(page.getByTestId("wallet-send")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __nearCalls: unknown[] }).__nearCalls.length)).toBe(0);
});
