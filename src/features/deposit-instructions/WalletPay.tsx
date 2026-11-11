/**
 * Wallet path after sentinel verification (§4 pay_wallet, §5.4): the review frame and its variants:
 * updated total after a re-quote, test mode ("Try a payment" + Simulate payment, never a broadcast —
 * §5.8), approve in your wallet, not approved, not enough funds. Every amount shown is the ATTESTED one.
 *
 * Design v2 review ("Pay with"): Network and Token cards (the chosen option, with the wallet balance;
 * tapping either is the former "Change"), the connected-wallet line with the network-fee pre-check
 * verdict, the fee card (Merchant receives / Routing fee / Network fee, plus "You send" on phones where
 * the order summary is collapsed), "Pay <amount>", "Pay from another wallet or exchange" and the
 * price-hold countdown.
 */

import {
  Button,
  Callout,
  ClockIcon,
  Countdown,
  formatMoney,
  type KeyValueItem,
  KeyValueList,
  Money,
  PickerTrigger,
  SelectionCard,
  WalletIcon,
  WarningIcon,
} from "@nearpay-internal/ui";
import { formatBaseUnits } from "@nearpay-money/spec";
import type { ReactNode } from "react";
import { moneyText, referenceText, type ViewModel } from "../../app/model";
import type { ScreenId } from "../../app/screens";
import type { Checkout } from "../../app/useCheckout";
import { chainName, getChain } from "../../lib/chains/chains";
import { t } from "../../lib/i18n/t";
import { assetMoney } from "../../lib/money/display";
import { roundUpSignificant } from "../../lib/money/format";
import { ScreenTitle, StateScreen, WalletLine } from "../../ui/blocks";
import { CryptoIcon } from "../../ui/CryptoIcon";
import { shortAddress } from "../wallet-connect/wallets";

/** Splits a message around `{time}` so a live `<Countdown>` can sit inside the sentence. */
export function withCountdown(template: string, deadline: number, onExpire?: () => void): ReactNode {
  const [before, after] = template.split("{time}");
  return (
    <>
      {before}
      <Countdown deadline={deadline} {...(onExpire ? { onExpire } : {})} />
      {after}
    </>
  );
}

function amountNode(amount: string | null, vm: ViewModel): ReactNode {
  if (!amount) return "—";
  const m = assetMoney(amount, vm.asset);
  return m ? <Money {...m} /> : `${amount} base units`;
}

function amountText(amount: string | null, vm: ViewModel): string {
  if (!amount) return "";
  return moneyText(assetMoney(amount, vm.asset), `${amount} base units`);
}

function network(c: Checkout): string {
  const a = c.state.verified?.attestation;
  if (!a) return "";
  return a.kind === "intents_transfer" ? "NEAR Intents" : chainName(a.deposit?.chain ?? "");
}

/** Chain of the attested instructions for its logo ("intents" for NEAR Intents transfers). */
function networkIconId(c: Checkout): string {
  const a = c.state.verified?.attestation;
  if (!a) return "";
  return a.kind === "intents_transfer" ? "intents" : (a.deposit?.chain ?? "");
}

/**
 * The chosen option as the "Pay with" cards (kit `PickerTrigger` look): Network and Token, the token
 * with the wallet's balance. Either card goes back to the choice (the former "Change", `change`).
 */
function ReviewPickers({
  c,
  vm,
  balance,
  disabled,
}: {
  c: Checkout;
  vm: ViewModel;
  balance: string | null;
  disabled: boolean;
}) {
  const symbol = vm.asset?.symbol ?? c.state.option?.symbol ?? "";
  const net = network(c);
  const tokenValue = balance ? `${symbol}, ${t("asset.balanceLabel")} ${balance}` : symbol;
  return (
    <div className="np-pickers ck-review-pickers">
      <PickerTrigger
        caption={t("asset.network")}
        value={net}
        avatar={<CryptoIcon kind="chain" id={networkIconId(c)} label={net || "?"} />}
        onClick={c.actions.change}
        disabled={disabled}
        aria-label={t("review.changeTrigger", { caption: t("asset.network"), value: net })}
        data-testid="change-network"
      />
      <PickerTrigger
        caption={t("asset.token")}
        value={symbol}
        avatar={<CryptoIcon kind="token" id={symbol} label={symbol || "?"} />}
        balance={balance ?? undefined}
        selected
        onClick={c.actions.change}
        disabled={disabled}
        aria-label={t("review.changeTrigger", { caption: t("asset.token"), value: tokenValue })}
        data-testid="change-option"
      />
    </div>
  );
}

/** "Mock Wallet 0x4De0…7559 connected · balance covers the network fee" (pre-check verdict when known). */
function WalletStatus({ c }: { c: Checkout }) {
  const w = c.state.wallet;
  if (!w) return null;
  const intents = c.state.verified?.attestation.kind === "intents_transfer";
  const fee = intents
    ? t("review.feeNone")
    : c.gas?.state === "ok"
      ? t("review.feeCovered")
      : c.gas?.state === "checking"
        ? t("review.feeChecking")
        : null;
  const line = t("review.walletShort", { address: shortAddress(w.address) });
  return <WalletLine testId="review-wallet">{fee ? `${line} · ${fee}` : line}</WalletLine>;
}

/**
 * Fee card: Merchant receives (the price), Routing fee (the payer fee when known: attested for Intents
 * transfers, `fee_amount` checked against the attested total for route quotes — else "Included in
 * total"), Network fee (paid by the wallet, which shows it before approval). Phones add "You send"
 * (the attested total): their order summary is collapsed. The network-fee note keeps the chain switch
 * and Solana rent details.
 */
function FeeCard({ c, vm, wide }: { c: Checkout; vm: ViewModel; wide: boolean }) {
  const att = c.state.verified?.attestation;
  const intents = att?.kind === "intents_transfer";
  const rows: KeyValueItem[] = [
    {
      label: t("fees.merchant"),
      value: <span data-testid="purchase">{vm.price ? <Money {...vm.price} /> : vm.priceText}</span>,
    },
    {
      label: t("fees.routing"),
      value:
        vm.fee === "0" ? (
          <span data-testid="payment-fees">{t("summary.feesNone")}</span>
        ) : vm.fee ? (
          <span data-testid="payment-fees">{amountNode(vm.fee, vm)}</span>
        ) : (
          <span className="np-text-secondary">{t("summary.feesIncluded")}</span>
        ),
    },
    intents
      ? { label: t("fees.networkIntents"), value: t("fees.networkNone") }
      : { label: t("fees.network"), value: <span className="np-text-secondary">{t("fees.networkWallet")}</span> },
  ];
  if (!wide) {
    rows.push({
      label: t("summary.youSend"),
      value: <span data-testid="total-to-send">{amountNode(vm.total, vm)}</span>,
      total: true,
    });
  }
  const evm = att?.kind === "route_quote" && att.deposit && getChain(att.deposit.chain)?.family === "evm";
  const sol = c.state.wallet?.family === "solana";
  const rent = c.solana?.state === "ready" ? c.solana.rentLamports : null;
  return (
    <div className="ck-fees" data-testid="fee-card">
      <KeyValueList className="ck-fees__rows" items={rows} />
      {/* With a network-fee warning on screen, the generic fee note would only repeat it. */}
      <p className="ck-fees__note" data-testid="network-fee-note" hidden={c.gas?.state === "short"}>
        {intents ? t("review.intentsFee") : sol ? t("review.solanaFee") : t("review.walletFee")}
        {evm && att?.deposit ? ` ${t("review.switchChain", { chain: chainName(att.deposit.chain) })}` : ""}
        {rent ? ` ${t("review.solanaRent", { amount: `${formatBaseUnits(rent, 9)} SOL` })}` : ""}
      </p>
    </div>
  );
}

function QuoteNote({ c }: { c: Checkout }) {
  const until = c.state.verified?.validUntil;
  if (!until) return null;
  return (
    <p className="np-checkout__note ck-center ck-hold" data-testid="countdown">
      {withCountdown(t("review.quote"), until)}
    </p>
  );
}

/**
 * The wallet holds the payment but not the network fee (pre-check, `c.gas` short): say how much is
 * needed and offer the deposit-address path (no gas from this wallet) or another network / token.
 * The wallet is not opened.
 */
function GasWarning({ c, onManual }: { c: Checkout; onManual: () => void }) {
  const g = c.gas;
  if (g?.state !== "short") return null;
  const amount = formatMoney({
    amount: roundUpSignificant(BigInt(g.need)).toString(),
    decimals: g.decimals,
    symbol: g.symbol,
  });
  const vars = { amount, chain: chainName(g.chain), symbol: g.symbol };
  return (
    <>
      <Callout tone="warning" title={t("gas.title", { symbol: g.symbol })} live data-testid="gas-warning">
        {t(g.native ? "gas.bodyNative" : "gas.body", vars)}
      </Callout>
      <div className="np-stack">
        <Button fullWidth onClick={onManual} data-testid="gas-manual">
          {t("gas.manual")}
        </Button>
        <Button fullWidth variant="secondary" onClick={c.actions.change} data-testid="gas-change">
          {t("gas.change")}
        </Button>
        <button type="button" className="np-link-button ck-center" onClick={c.retryGas} data-testid="gas-recheck">
          {t("gas.again")}
        </button>
      </div>
    </>
  );
}

export function WalletPay({
  c,
  vm,
  screen,
  wide,
  balance = null,
  onManual,
}: {
  c: Checkout;
  vm: ViewModel;
  screen: Extract<
    ScreenId,
    | "review"
    | "review_updated"
    | "test_payment"
    | "approve_in_wallet"
    | "not_approved"
    | "not_enough_funds"
    | "tx_failed"
  >;
  /** Desktop split layout: the order side shows "You send", so the fee card leaves it out. */
  wide: boolean;
  /** Formatted wallet balance of the chosen token (read on "Pay with"), if known. */
  balance?: string | null;
  /** Switch to the deposit-address path (keeps the chosen token preselected). */
  onManual: () => void;
}) {
  const gasShort = c.gas?.state === "short";
  const { actions, busy } = c;
  const total = amountText(vm.total, vm);
  const ref = vm.reference ? referenceText(vm.reference, vm.merchant?.name ?? null) : undefined;

  if (screen === "approve_in_wallet") {
    return (
      <StateScreen
        testId="wallet-pay"
        icon={<ClockIcon />}
        iconTone="progress"
        title={t("approve.title")}
        body={t("approve.body", { amount: total, chain: network(c) })}
        badge={t("approve.badge")}
        callout={t("approve.callout")}
        reference={ref}
        actions={
          <Button fullWidth loading loadingText={t("approve.waiting")} data-testid="wallet-send">
            {t("approve.waiting")}
          </Button>
        }
      />
    );
  }

  if (screen === "not_approved") {
    return (
      <StateScreen
        testId="wallet-pay"
        icon={<WalletIcon />}
        iconTone="warning"
        title={t("notApproved.title")}
        body={t("notApproved.body")}
        badge={t("notApproved.badge")}
        callout={t("notApproved.callout")}
        reference={ref}
        actions={
          <>
            <Button fullWidth onClick={actions.clearError} data-testid="try-again">
              {t("notApproved.retry")}
            </Button>
            <Button fullWidth variant="secondary" onClick={actions.change}>
              {t("funds.change")}
            </Button>
          </>
        }
      />
    );
  }

  if (screen === "tx_failed") {
    return (
      <StateScreen
        testId="wallet-pay"
        icon={<WarningIcon />}
        iconTone="danger"
        title={t("txFailed.title")}
        body={t("txFailed.body")}
        badge={t("txFailed.badge")}
        callout={c.state.error?.param ? t("wallet.failed", { message: c.state.error.param }) : undefined}
        reference={ref}
        actions={
          <>
            <Button fullWidth onClick={actions.clearError} data-testid="try-again">
              {t("txFailed.retry")}
            </Button>
            <Button fullWidth variant="secondary" onClick={actions.useManual} data-testid="use-manual">
              {t("txFailed.manual")}
            </Button>
          </>
        }
      />
    );
  }

  if (screen === "not_enough_funds") {
    const symbol = vm.asset?.symbol ?? "";
    return (
      <section className="ck-screen" data-testid="wallet-pay">
        <SelectionCard
          avatar={<CryptoIcon kind="token" id={symbol} label={symbol || "?"} />}
          title={`${symbol} · ${network(c)}`}
          description={t("funds.needed", { amount: total })}
        />
        <Callout tone="warning" title={t("funds.callout")} live>
          {t("funds.body")}
        </Callout>
        <div className="np-stack">
          <Button fullWidth onClick={actions.change} data-testid="choose-another">
            {t("funds.change")}
          </Button>
          <Button fullWidth variant="secondary" onClick={actions.clearError} data-testid="check-again">
            {t("funds.again")}
          </Button>
        </div>
      </section>
    );
  }

  if (screen === "test_payment") {
    return (
      <section className="ck-screen" data-testid="wallet-pay" aria-labelledby="ck-test-title">
        <ScreenTitle id="ck-test-title" title={t("test.title")} lede={t("test.body")} />
        <ReviewPickers c={c} vm={vm} balance={null} disabled={busy} />
        <WalletStatus c={c} />
        <FeeCard c={c} vm={vm} wide={wide} />
        <div className="np-stack ck-pay-actions">
          <Button
            fullWidth
            size="lg"
            onClick={() => void actions.simulate()}
            loading={busy}
            loadingText={t("test.simulating")}
            data-testid="simulate"
          >
            {t("test.simulate")}
          </Button>
          <QuoteNote c={c} />
        </div>
      </section>
    );
  }

  const payLabel = t("review.pay", { amount: total });
  if (screen === "review_updated" && c.previousTotal) {
    return (
      <section className="ck-screen" data-testid="wallet-pay" aria-labelledby="ck-updated-title">
        <Callout tone="warning" title={t("updated.callout")} reference={ref} live />
        <ScreenTitle id="ck-updated-title" title={t("updated.title")} lede={t("updated.body")} />
        <div className="np-stack np-stack--sm">
          <KeyValueList
            items={[
              { label: t("updated.previous"), value: amountNode(c.previousTotal, vm) },
              {
                label: t("updated.updated"),
                value: <span data-testid="total-to-send">{amountNode(vm.total, vm)}</span>,
              },
            ]}
          />
          <p className="np-checkout__note">{t("updated.includes")}</p>
        </div>
        {gasShort ? (
          <GasWarning c={c} onManual={onManual} />
        ) : (
          <div className="np-stack ck-pay-actions">
            <Button
              fullWidth
              size="lg"
              onClick={() => void actions.payWithWallet()}
              loading={c.preparing}
              loadingText={t("gas.checking")}
              data-testid="wallet-send"
            >
              {payLabel}
            </Button>
            <QuoteNote c={c} />
          </div>
        )}
      </section>
    );
  }

  const sol = c.solana;
  return (
    <section className="ck-screen ck-review" data-testid="wallet-pay" aria-labelledby="ck-review-title">
      <h1 className="np-checkout__title" id="ck-review-title">
        {t("review.title")}
      </h1>
      <div className="ck-review__choice">
        <ReviewPickers c={c} vm={vm} balance={balance} disabled={busy} />
        <WalletStatus c={c} />
      </div>
      <FeeCard c={c} vm={vm} wide={wide} />
      {sol?.state === "manual" ? (
        <Callout tone="warning" title={t("review.solanaManualTitle")} live data-testid="solana-manual-only">
          {t(`review.solanaManual.${sol.reason}`)}
        </Callout>
      ) : sol?.state === "error" ? (
        <Callout tone="danger" title={t("review.solanaError")} live data-testid="solana-rpc-error" />
      ) : null}
      {gasShort ? (
        <GasWarning c={c} onManual={onManual} />
      ) : (
        <div className="np-stack ck-pay-actions">
          {sol?.state === "manual" ? (
            <Button fullWidth size="lg" onClick={actions.useManual} data-testid="use-manual">
              {t("txFailed.manual")}
            </Button>
          ) : sol?.state === "error" ? (
            <Button fullWidth size="lg" onClick={c.retrySolana} data-testid="solana-retry">
              {t("review.solanaRetry")}
            </Button>
          ) : (
            <Button
              fullWidth
              size="lg"
              onClick={() => void actions.payWithWallet()}
              loading={sol?.state === "checking" || c.preparing}
              loadingText={c.preparing ? t("gas.checking") : t("review.solanaChecking")}
              data-testid="wallet-send"
            >
              {payLabel}
            </Button>
          )}
          {sol?.state !== "manual" ? (
            <Button fullWidth variant="secondary" onClick={actions.useManual} data-testid="use-manual">
              {t("review.sendAnother")}
            </Button>
          ) : null}
          <QuoteNote c={c} />
        </div>
      )}
    </section>
  );
}
