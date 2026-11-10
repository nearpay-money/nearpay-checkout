/**
 * Wallet path after sentinel verification (§4 pay_wallet, §5.4): the review frame (token card with
 * Change, Purchase / Payment fees / Total to send, wallet network-fee note, Pay, quote countdown) and
 * its variants: updated total after a re-quote, test mode ("Try a payment" + Simulate payment, never a
 * broadcast — §5.8), approve in your wallet, not approved, not enough funds. Every amount shown is the
 * ATTESTED one.
 */

import { formatBaseUnits } from "@nearpay/spec";
import {
  Button,
  Callout,
  ClockIcon,
  Countdown,
  formatMoney,
  type KeyValueItem,
  KeyValueList,
  Money,
  SelectionCard,
  WalletIcon,
  WarningIcon,
} from "@nearpay-internal/ui";
import type { ReactNode } from "react";
import { moneyText, referenceText, type ViewModel } from "../../app/model";
import type { ScreenId } from "../../app/screens";
import type { Checkout } from "../../app/useCheckout";
import { chainName, getChain } from "../../lib/chains/chains";
import { t } from "../../lib/i18n/t";
import { assetMoney } from "../../lib/money/display";
import { roundUpSignificant } from "../../lib/money/format";
import { ScreenTitle, StateScreen } from "../../ui/blocks";
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

function Selection({ c, vm, disabled }: { c: Checkout; vm: ViewModel; disabled: boolean }) {
  const w = c.state.wallet;
  const symbol = vm.asset?.symbol ?? c.state.option?.symbol ?? "";
  return (
    <SelectionCard
      avatar={symbol || "?"}
      title={`${symbol} · ${network(c)}`}
      description={w ? t("wallet.address", { address: shortAddress(w.address) }) : undefined}
      action={
        <button
          type="button"
          className="np-link-button"
          onClick={c.actions.change}
          disabled={disabled}
          data-testid="change-option"
        >
          {t("review.change")}
        </button>
      }
    />
  );
}

function Totals({ c, vm, compact = false }: { c: Checkout; vm: ViewModel; compact?: boolean }) {
  // Desktop: the order summary column carries the breakdown; the review card shows what is sent.
  // Phones: "Total to send" stays visible; Purchase and Payment fees move into a disclosure.
  const total: KeyValueItem = compact
    ? { label: t("summary.youSend"), value: <span data-testid="total-to-send">{amountNode(vm.total, vm)}</span> }
    : {
        label: t("summary.totalToSend"),
        value: <span data-testid="total-to-send">{amountNode(vm.total, vm)}</span>,
        total: true,
      };
  const breakdown: KeyValueItem[] = [
    {
      label: t("summary.purchase"),
      value: <span data-testid="purchase">{vm.price ? <Money {...vm.price} /> : vm.priceText}</span>,
    },
    {
      label: t("summary.fees"),
      value:
        vm.fee === "0" ? (
          <span data-testid="payment-fees">{t("summary.feesNone")}</span>
        ) : vm.fee ? (
          <span data-testid="payment-fees">{amountNode(vm.fee, vm)}</span>
        ) : (
          <span className="np-text-secondary">{t("summary.feesIncluded")}</span>
        ),
    },
  ];
  const att = c.state.verified?.attestation;
  const evm = att?.kind === "route_quote" && att.deposit && getChain(att.deposit.chain)?.family === "evm";
  const sol = c.state.wallet?.family === "solana";
  const rent = c.solana?.state === "ready" ? c.solana.rentLamports : null;
  return (
    <div className="np-stack np-stack--sm">
      {compact ? null : (
        <details className="ck-disclosure" data-testid="fee-details">
          <summary className="ck-disclosure__summary">{t("review.feeDetails")}</summary>
          <KeyValueList items={breakdown} />
        </details>
      )}
      <KeyValueList items={[total]} />
      {/* With a network-fee warning on screen, the generic fee note would only repeat it. */}
      <p className="np-checkout__note" data-testid="network-fee-note" hidden={c.gas?.state === "short"}>
        {att?.kind === "intents_transfer"
          ? t("review.intentsFee")
          : sol
            ? t("review.solanaFee")
            : t("review.walletFee")}
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
    <p className="np-checkout__note ck-center" data-testid="countdown">
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
  /** Desktop review: also offer "Send from another wallet". */
  wide: boolean;
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
          avatar={symbol || "?"}
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
        <Selection c={c} vm={vm} disabled={busy} />
        <Totals c={c} vm={vm} />
        <div className="np-stack">
          <Button
            fullWidth
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
          <div className="np-stack">
            <Button
              fullWidth
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
    <section className="ck-screen" data-testid="wallet-pay" aria-labelledby="ck-review-title">
      <h1 className={wide ? "ck-review-title" : "np-sr-only"} id="ck-review-title">
        {t("review.title")}
      </h1>
      <Selection c={c} vm={vm} disabled={busy} />
      <Totals c={c} vm={vm} compact={wide} />
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
        <div className="np-stack">
          {sol?.state === "manual" ? (
            <Button fullWidth onClick={actions.useManual} data-testid="use-manual">
              {t("txFailed.manual")}
            </Button>
          ) : sol?.state === "error" ? (
            <Button fullWidth onClick={c.retrySolana} data-testid="solana-retry">
              {t("review.solanaRetry")}
            </Button>
          ) : (
            <Button
              fullWidth
              onClick={() => void actions.payWithWallet()}
              loading={sol?.state === "checking" || c.preparing}
              loadingText={c.preparing ? t("gas.checking") : t("review.solanaChecking")}
              data-testid="wallet-send"
            >
              {payLabel}
            </Button>
          )}
          {wide && sol?.state !== "manual" ? (
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
