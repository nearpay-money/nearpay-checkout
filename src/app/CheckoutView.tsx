/** Renders the checkout for the current machine phase (shared by hosted and embedded mode). */
import { type ReactNode, useState } from "react";
import { AssetPicker } from "../features/asset-picker/AssetPicker";
import { ManualInstructions } from "../features/deposit-instructions/ManualInstructions";
import { VerifiedMerchant } from "../features/deposit-instructions/VerifiedMerchant";
import { WalletPay } from "../features/deposit-instructions/WalletPay";
import { WalletConnect } from "../features/wallet-connect/WalletConnect";
import { shortAddress } from "../features/wallet-connect/wallets";
import { errorText, hasMessage, t } from "../lib/i18n/t";
import { formatBaseUnits, formatPrice } from "../lib/money/format";
import { Button, Notice, Section, Spinner } from "../ui/primitives";
import type { Checkout } from "./useCheckout";

function priceOf(c: Checkout): string {
  const s = c.state.session;
  if (!s) return "";
  try {
    return formatPrice(s.amount, s.currency, null);
  } catch {
    return String(s.amount);
  }
}

function verifyReason(reason: string, field?: string): string {
  const key = `verifyReason.${reason}`;
  return hasMessage(key) ? t(key, { field: field ?? "" }) : reason;
}

function errorMessage(code: string, param?: string | null): string {
  if (code === "wallet_rejected") return t("wallet.rejected");
  if (code === "wallet_failed") return t("wallet.failed", { message: param ?? "" });
  return errorText(code);
}

export function CheckoutView({ c, footer }: { c: Checkout; footer?: ReactNode }) {
  const { state, actions, busy } = c;
  const [refund, setRefund] = useState("");
  const s = state.session;
  const testMode = s ? !s.livemode : false;
  const body = (() => {
    switch (state.phase) {
      case "loading":
        return <Spinner label={t("app.loading")} />;
      case "blocked":
        return (
          <Section title={t("blocked.title")} testId="blocked">
            <p data-testid={`blocked-${state.blockReason}`}>{t(`blocked.${state.blockReason ?? "load_failed"}`)}</p>
          </Section>
        );
      case "choose_path":
        return (
          <Section title={t("path.title")} testId="choose-path">
            <div className="np-paths">
              <button
                type="button"
                className="np-path"
                onClick={() => actions.choosePath("wallet")}
                data-testid="path-wallet"
              >
                <strong>{t("path.wallet")}</strong>
                <span className="np-muted">{t("path.walletHint")}</span>
              </button>
              <button
                type="button"
                className="np-path"
                onClick={() => actions.choosePath("manual")}
                data-testid="path-manual"
              >
                <strong>{t("path.manual")}</strong>
                <span className="np-muted">{t("path.manualHint")}</span>
              </button>
            </div>
          </Section>
        );
      case "connect_wallet":
        return <WalletConnect onConnected={actions.connected} />;
      case "choose_asset":
        return (
          <>
            {state.wallet ? (
              <p className="np-help" data-testid="connected-wallet">
                {t("wallet.connected", { address: `${state.wallet.label} · ${shortAddress(state.wallet.address)}` })}
              </p>
            ) : null}
            <AssetPicker
              options={state.options}
              selected={state.option}
              path={state.path ?? "manual"}
              busy={busy}
              attemptSeq={`${state.attempt?.id ?? "first"}:${state.error?.code ?? ""}`}
              refund={refund}
              onRefund={setRefund}
              onSelect={actions.selectOption}
              onConfirm={(i) => void actions.confirm(i)}
            />
          </>
        );
      case "confirming":
        return <Spinner label={t("confirm.title")} />;
      case "verifying":
        return (
          <Section testId="verifying">
            <Spinner label={t("verify.title")} />
            <p className="np-help">{t("verify.hint")}</p>
          </Section>
        );
      case "verify_failed":
        return (
          <Section title={t("verifyFailed.title")} testId="verify-failed">
            <Notice kind="error">{t("verifyFailed.body")}</Notice>
            {state.verifyFailure ? (
              <p className="np-help" data-testid="verify-reason">
                {t("verifyFailed.reason", {
                  reason: verifyReason(state.verifyFailure.reason, state.verifyFailure.field),
                })}
              </p>
            ) : null}
            <Button onClick={actions.retry} testId="retry">
              {t("verifyFailed.retry")}
            </Button>
          </Section>
        );
      case "pay_wallet":
      case "pay_manual":
      case "needs_top_up":
        if (!state.verified) return <Spinner label={t("verify.title")} />;
        return (
          <>
            <VerifiedMerchant verified={state.verified} />
            {state.replacedAttempt ? (
              <Notice kind="warn" testId="replaced">
                {t("deposit.replaced")}
              </Notice>
            ) : null}
            {state.phase === "pay_wallet" ? (
              <WalletPay
                verified={state.verified}
                meta={c.originMeta}
                testMode={testMode}
                busy={busy}
                onPay={() => void actions.payWithWallet()}
                onSimulate={() => void actions.simulate()}
              />
            ) : (
              <ManualInstructions
                verified={state.verified}
                meta={c.originMeta}
                testMode={testMode}
                topUp={state.phase === "needs_top_up"}
                busy={busy}
                onSent={() => void actions.signalSent()}
                onSimulate={() => void actions.simulate()}
              />
            )}
          </>
        );
      case "expired_address":
        return (
          <Section testId="expired-address">
            <Notice kind="error">{t("deposit.expired")}</Notice>
            {s?.status === "open" ? (
              <Button onClick={actions.retry} testId="new-address">
                {t("deposit.newAddress")}
              </Button>
            ) : null}
          </Section>
        );
      case "processing":
        return (
          <Section title={t("processing.title")} testId="processing">
            <Spinner
              label={state.attempt?.status === "awaiting_deposit" ? t("processing.waiting") : t("processing.title")}
            />
            <p className="np-help">{t("processing.body")}</p>
          </Section>
        );
      case "review":
        return (
          <Section title={t("review.title")} testId="review">
            <p>{t("review.body")}</p>
          </Section>
        );
      case "refunded": {
        const a = state.attempt;
        const meta = c.originMeta;
        return (
          <Section title={t("refunded.title")} testId="refunded">
            <p>{t("refunded.body")}</p>
            {a?.refunded_amount && meta ? (
              <p className="np-help">
                {t("refunded.amount", {
                  amount: `${formatBaseUnits(a.refunded_amount, meta.decimals)} ${meta.symbol}`,
                })}
              </p>
            ) : null}
            {s?.status === "open" ? (
              <Button onClick={actions.retry} testId="retry">
                {t("refunded.retry")}
              </Button>
            ) : null}
          </Section>
        );
      }
      case "succeeded":
        return (
          <Section title={t("succeeded.title")} testId="succeeded">
            <Notice kind="success">{t("succeeded.body")}</Notice>
          </Section>
        );
    }
  })();

  const canGoBack = state.phase === "connect_wallet" || state.phase === "choose_asset";
  return (
    <main className="np-card" aria-busy={busy}>
      {testMode ? (
        <div className="np-testmode" data-testid="test-banner">
          {t("app.testmode")}
        </div>
      ) : null}
      {s ? (
        <header className="np-header">
          <div className="np-label">{t("summary.pay")}</div>
          <div className="np-price" data-testid="price">
            {priceOf(c)}
          </div>
          {s.display.description ? (
            <div className="np-muted" data-testid="description">
              {s.display.description}
            </div>
          ) : null}
        </header>
      ) : null}
      {state.error ? (
        <Notice kind="error" testId="error">
          {errorMessage(state.error.code, state.error.param)}
        </Notice>
      ) : null}
      {c.streamMode === "polling" && state.phase === "processing" ? (
        <p className="np-help">{t("app.liveStatusPolling")}</p>
      ) : null}
      {body}
      <footer className="np-footer">
        {canGoBack ? (
          <Button kind="link" onClick={actions.back} testId="back">
            {t("app.back")}
          </Button>
        ) : null}
        {footer}
        <span className="np-muted">{t("app.poweredBy")}</span>
      </footer>
    </main>
  );
}
