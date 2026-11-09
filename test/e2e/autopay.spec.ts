/**
 * Hosted invoice auto-pay (Stage 4, lld/checkout-and-js.md §4.4; billing §5/§14 d5/d8): funding terms,
 * the payer's own NEAR wallet signs storage_deposit + ft_transfer_call (token → vault) exactly as
 * returned and checked, mandate status, top-up / cancel / withdraw, test mode never signs.
 */
import type { Page } from "@playwright/test";
import { funding, mandate, USDC, VAULT, withdrawTx } from "../support/mandates";
import { a11yBasics } from "./support/a11y";
import { expect, test } from "./support/fixtures";
import type { MockInvoice, MockNearPay } from "./support/mock-server";
import { injectNearWallet } from "./support/wallets";

type AutoDebit = { available: boolean; mandate: `md_${string}` | null; collecting: boolean };
const AVAILABLE: AutoDebit = { available: true, mandate: null, collecting: false };
const MANDATE_ID = "md_01jbz9k3m4n5p6q7r8s9t0v1w2" as const;

type NearCall = { method: string; params: { receiverId: string; actions: { params: Record<string, unknown> }[] }[] };
const nearCalls = (page: Page) => page.evaluate(() => (window as unknown as { __nearCalls: NearCall[] }).__nearCalls);

async function open(page: Page, mock: MockNearPay, m: MockInvoice) {
  await page.goto(mock.invoiceUrl(m));
  await expect(page.getByTestId("invoice-page")).toBeVisible();
}

function liveInvoice(mock: MockNearPay, auto: AutoDebit = AVAILABLE, opts: Partial<MockInvoice> = {}) {
  return mock.createInvoice({ livemode: true, auto_debit: auto }, opts);
}

test("setup: clear terms, payer notice, own-account confirmation, wallet signs exactly the checked transactions", async ({
  page,
  mock,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await injectNearWallet(page);
  const m = liveInvoice(mock);
  await open(page, mock, m);
  await expect(page.getByTestId("autopay-entry")).toContainText("Pay future invoices automatically");
  await page.getByTestId("autopay-setup").click();

  const terms = page.getByTestId("autopay-terms");
  await expect(terms).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Set up auto-pay");
  await expect(page.getByTestId("autopay-per-period")).toHaveText("10.00 USDC");
  await expect(terms).toContainText("Amount each month");
  await expect(page.getByTestId("autopay-first")).toHaveText("Right away, to pay this invoice");
  await expect(page.getByTestId("autopay-receiver")).toHaveText("merchant-demo.near");
  await expect(page.getByTestId("autopay-vault")).toHaveText(VAULT);
  await expect(page.getByTestId("autopay-fund-amount")).toHaveText("30.00 USDC");
  await expect(page.getByTestId("autopay-storage")).toContainText("0.012 NEAR");
  await expect(page.getByTestId("autopay-payer-notice")).toContainText("from your own NEAR account");
  await expect(page.getByTestId("autopay-facts")).toContainText("not with NearPay or the merchant");
  await expect(page.getByTestId("autopay-fee")).toContainText("NearPay's 1% out of each collection");
  await expect(page.getByTestId("autopay-facts")).toContainText("from the NEAR account you pay with");
  await expect(page.getByTestId("autopay-payer-notice")).toContainText("from the NEAR account you pay with");
  await expect(page.getByText(/any NEAR wallet/)).toHaveCount(0);
  // No unverified merchant name anywhere (L-CK-03).
  await expect(page.getByText("Acme (unverified)")).toHaveCount(0);
  await a11yBasics(page);

  // The preview call carried no payer; the secret travelled only in the header.
  expect(mock.bodyOf("createPublicInvoiceMandateFunding", 0)).toEqual({ periods: 3 });
  expect(mock.callsTo("createPublicInvoiceMandateFunding")[0]?.headers["x-nearpay-invoice-secret"]).toBe(m.secret);

  const approve = page.getByTestId("autopay-approve");
  await expect(approve).toBeDisabled();
  await page.getByTestId("autopay-own-account").check();
  await approve.click();
  await expect(page.getByTestId("autopay-waiting")).toBeVisible();
  await expect(page.getByTestId("autopay-waiting")).toContainText("9XKGkKdV8ZP2t5cE6z6V8S1Ud6eS3wQ7t2Fq9KcYQm1e");

  expect(mock.bodyOf("createPublicInvoiceMandateFunding", 1)).toEqual({ payer: "payer.near", periods: 3 });
  const calls = await nearCalls(page);
  expect(calls).toHaveLength(1);
  const f = funding({ payer: "payer.near", periods: 3 });
  expect(calls[0]?.params).toEqual(
    f.transactions.map((t) => ({
      receiverId: t.receiver_id,
      actions: t.actions.map((a) => ({
        type: "FunctionCall",
        params: { methodName: a.method_name, args: a.args, gas: a.gas, deposit: a.deposit },
      })),
    })),
  );
  expect(calls[0]?.params[1]).toMatchObject({
    receiverId: USDC,
    actions: [{ params: { methodName: "ft_transfer_call", args: { receiver_id: VAULT, amount: "30000000" } } }],
  });

  // Billing records the mandate from the chain event → the page switches to the management view.
  m.invoice.auto_debit = { available: false, mandate: MANDATE_ID, collecting: true };
  m.mandate = mandate({ balance: "30000000", funded_periods: 3, collected_periods: 0 });
  await expect(page.getByTestId("autopay-manage-view")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("autopay-status")).toHaveText("Active");
  await expect(page.getByTestId("autopay-balance")).toHaveText("30.00 USDC");
});

test("setup: chosen periods are requested and shown; registered payer signs one transaction", async ({
  page,
  mock,
}) => {
  await injectNearWallet(page);
  const m = liveInvoice(mock, AVAILABLE, {
    funding: (b) => funding({ periods: b.periods ?? 3, payer: b.payer ?? null, registered: Boolean(b.payer) }),
  });
  await open(page, mock, m);
  await page.getByTestId("autopay-setup").click();
  await page.getByRole("radio", { name: /Fund 6 months/ }).check();
  await expect(page.getByTestId("autopay-fund-amount")).toHaveText("60.00 USDC");
  await page.getByTestId("autopay-own-account").check();
  await page.getByTestId("autopay-approve").click();
  await expect(page.getByTestId("autopay-waiting")).toBeVisible();
  expect(mock.bodyOf("createPublicInvoiceMandateFunding", 1)).toEqual({ payer: "payer.near", periods: 6 });
  const calls = await nearCalls(page);
  expect(calls[0]?.params).toHaveLength(1);
  expect(calls[0]?.params[0]?.actions[0]?.params).toMatchObject({ args: { amount: "60000000" } });
});

test("setup: transactions that don't match the terms are never signed (fail closed)", async ({ page, mock }) => {
  await injectNearWallet(page);
  const m = liveInvoice(mock, AVAILABLE, {
    funding: (b) => {
      const f = funding({ periods: b.periods ?? 3, payer: b.payer ?? null });
      if (!b.payer) return f;
      const ft = f.transactions[1];
      if (!ft) return f;
      const a = ft.actions[0] as (typeof ft.actions)[number];
      return {
        ...f,
        transactions: [
          f.transactions[0],
          { ...ft, actions: [{ ...a, args: { ...a.args, receiver_id: "evil.near" } }] },
        ],
      } as typeof f;
    },
  });
  await open(page, mock, m);
  await page.getByTestId("autopay-setup").click();
  await page.getByTestId("autopay-own-account").check();
  await page.getByTestId("autopay-approve").click();
  await expect(page.getByTestId("error")).toContainText("don't match the terms shown. Nothing was signed.");
  expect(await nearCalls(page)).toEqual([]);
});

test("setup: wallet rejection keeps the terms; API errors map to friendly copy", async ({ page, mock }) => {
  await injectNearWallet(page);
  await page.addInitScript(() => {
    const w = (window as unknown as { __NP_E2E_NEAR_WALLET__: { signAndSendTransactions: () => Promise<never> } })
      .__NP_E2E_NEAR_WALLET__;
    w.signAndSendTransactions = async () => {
      throw new Error("User rejected the request");
    };
  });
  const m = liveInvoice(mock);
  await open(page, mock, m);
  await page.getByTestId("autopay-setup").click();
  await page.getByTestId("autopay-own-account").check();
  await page.getByTestId("autopay-approve").click();
  await expect(page.getByTestId("error")).toHaveText(
    "You didn't approve the transaction in your wallet. Nothing was sent.",
  );
  await expect(page.getByTestId("autopay-terms")).toBeVisible();

  m.fundingError = "auto_debit_unavailable";
  await page.getByTestId("autopay-back").click();
  await page.getByTestId("autopay-setup").click();
  await expect(page.getByTestId("autopay-failed")).toContainText("Auto-pay isn't available for this subscription.");
  await page.getByTestId("autopay-retry").click();
  await expect(page.getByTestId("autopay-terms")).toBeVisible();
});

test("test mode: terms are shown, nothing is signed", async ({ page, mock }) => {
  await injectNearWallet(page);
  const m = mock.createInvoice({ livemode: false, auto_debit: AVAILABLE });
  await open(page, mock, m);
  await page.getByTestId("autopay-setup").click();
  await expect(page.getByTestId("autopay-test-note")).toContainText("Wallets don't sign in test mode");
  await expect(page.getByTestId("autopay-approve")).toHaveCount(0);
  await expect(page.getByTestId("test-banner")).toBeVisible();
  expect(await nearCalls(page)).toEqual([]);
});

test("collecting invoice → manage: top up and cancel signed by the payer account only", async ({ page, mock }) => {
  await injectNearWallet(page);
  const m = liveInvoice(mock, { available: false, mandate: MANDATE_ID, collecting: true }, { mandate: mandate() });
  await open(page, mock, m);
  await expect(page.getByTestId("autopay-collecting")).toContainText("paid automatically");
  await page.getByTestId("autopay-manage").click();
  await expect(page.getByTestId("autopay-manage-view")).toBeVisible();
  await expect(page.getByTestId("autopay-balance")).toHaveText("20.00 USDC");
  await expect(page.getByTestId("autopay-next")).toHaveText("1 January 2100");
  await a11yBasics(page);

  await page.getByTestId("autopay-topup-open").click();
  await page.getByTestId("autopay-topup-approve").click();
  await expect(page.getByTestId("autopay-sent")).toBeVisible();
  let calls = await nearCalls(page);
  expect(calls[0]?.params).toEqual([
    {
      receiverId: USDC,
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: "ft_transfer_call",
            args: { receiver_id: VAULT, amount: "30000000", msg: '{"top_up":{"mandate_id":7}}' },
            gas: "100000000000000",
            deposit: "1",
          },
        },
      ],
    },
  ]);
  m.mandate = mandate({ balance: "50000000", funded_periods: 5 });
  await expect(page.getByTestId("autopay-balance")).toHaveText("50.00 USDC", { timeout: 10_000 });

  await page.getByTestId("autopay-cancel").click();
  await expect(page.getByTestId("autopay-cancel-dialog")).toContainText("goes back to payer.near");
  await page.getByTestId("autopay-cancel-confirm").click();
  await expect(page.getByTestId("autopay-sent")).toBeVisible();
  calls = await nearCalls(page);
  expect(calls[1]?.params).toEqual([
    {
      receiverId: VAULT,
      actions: [
        {
          type: "FunctionCall",
          params: { methodName: "cancel", args: { mandate_id: 7 }, gas: "100000000000000", deposit: "1" },
        },
      ],
    },
  ]);
});

test("manage: another account can't sign; orphaned mandate asks to cancel; withdraw after cancel", async ({
  page,
  mock,
}) => {
  await injectNearWallet(page);
  const m = liveInvoice(
    mock,
    { available: true, mandate: MANDATE_ID, collecting: false },
    { mandate: mandate({ payer: "someone-else.near", collecting: false }) },
  );
  await open(page, mock, m);
  await page.getByTestId("autopay-manage").click();
  await expect(page.getByTestId("autopay-orphaned")).toContainText("no longer collects");
  await expect(page.getByTestId("autopay-topup-open")).toHaveCount(0);
  await page.getByTestId("autopay-cancel").click();
  await page.getByTestId("autopay-cancel-confirm").click();
  await expect(page.getByTestId("autopay-cancel-dialog").getByText(/Connect someone-else.near/)).toBeVisible();
  expect(await nearCalls(page)).toEqual([]);
  await page.keyboard.press("Escape");

  m.mandate = mandate({
    status: "canceled",
    top_up_msg: null,
    collecting: false,
    balance: "20000000",
    transactions: { cancel: null, withdraw: withdrawTx },
  });
  await page.getByTestId("autopay-back").click();
  await page.getByTestId("autopay-manage").click();
  await expect(page.getByTestId("autopay-status")).toHaveText("Canceled");
  await expect(page.getByTestId("autopay-withdrawable")).toBeVisible();
  await page.getByTestId("autopay-withdraw").click();
  await expect(page.getByTestId("autopay-sent")).toBeVisible();
  const calls = await nearCalls(page);
  expect(calls[0]?.params[0]).toMatchObject({ receiverId: VAULT, actions: [{ params: { methodName: "withdraw" } }] });
});
