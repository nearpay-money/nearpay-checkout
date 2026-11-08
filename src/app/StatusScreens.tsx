/** Status frames of the checkout canvas (a00–a03): verifying, failures, confirming, complete, returns. */
import {
  ArrowRightIcon,
  Button,
  buttonClassName,
  CheckIcon,
  ClockIcon,
  KeyValueList,
  Money,
  ShieldCheckIcon,
  Skeleton,
  WalletIcon,
  WarningIcon,
} from "@nearpay-internal/ui";
import type { ReactNode } from "react";
import { hasMessage, t } from "../lib/i18n/t";
import { assetMoney } from "../lib/money/display";
import { CopyTextButton, StateScreen } from "../ui/blocks";
import type { BlockReason } from "./machine";
import { referenceText, type ViewModel } from "./model";
import type { Checkout } from "./useCheckout";

const ref = (vm: ViewModel) => (vm.reference ? referenceText(vm.reference, vm.merchant?.name ?? null) : undefined);

export function LoadingScreen({ label }: { label?: string } = {}) {
  return (
    <section className="ck-screen" aria-busy="true" data-testid="loading">
      <p className="np-sr-only" role="status">
        {label ?? t("app.loading")}
      </p>
      <Skeleton shape="title" width="50" />
      <Skeleton shape="text" width="75" />
      <Skeleton shape="block" />
      <Skeleton shape="block" />
    </section>
  );
}

export function BlockedScreen({ reason }: { reason: BlockReason }) {
  return (
    <StateScreen
      testId="blocked"
      icon={<WarningIcon />}
      title={t("blocked.title")}
      body={<span data-testid={`blocked-${reason}`}>{t(`blocked.${reason}`)}</span>}
    />
  );
}

export function VerifyingScreen({ vm }: { vm: ViewModel }) {
  return (
    <StateScreen
      testId="verifying"
      title={t("verify.title")}
      body={t("verify.body")}
      callout={t("verify.callout")}
      reference={vm.reference ? t("app.reference", { ref: shortRef(vm.reference) }) : undefined}
      actions={
        <Button fullWidth loading loadingText={t("verify.button")}>
          {t("verify.button")}
        </Button>
      }
    />
  );
}

function verifyReason(reason: string, field?: string): string {
  const key = `verifyReason.${reason}`;
  return hasMessage(key) ? t(key, { field: field ?? "" }) : reason;
}

export function VerifyFailedScreen({ c, vm }: { c: Checkout; vm: ViewModel }) {
  const f = c.state.verifyFailure;
  return (
    <StateScreen
      testId="verify-failed"
      title={t("verifyFailed.title")}
      body={t("verifyFailed.body")}
      callout={t("verifyFailed.callout")}
      calloutTone="warning"
      reference={vm.reference ? t("app.reference", { ref: shortRef(vm.reference) }) : undefined}
      actions={
        <>
          <Button fullWidth onClick={c.actions.retry} data-testid="retry">
            {t("verifyFailed.retry")}
          </Button>
          {f ? (
            <p className="np-checkout__note" data-testid="verify-reason">
              {t("verifyFailed.reason", { reason: verifyReason(f.reason, f.field) })}
            </p>
          ) : null}
        </>
      }
    />
  );
}

export function NoOptionsScreen({ c, vm, failed }: { c: Checkout; vm: ViewModel; failed?: boolean }) {
  return (
    <StateScreen
      testId={failed ? "not-completed" : "no-options"}
      icon={<WalletIcon />}
      title={t("noOptions.title")}
      body={failed ? t("notCompleted.body") : t("noOptions.body")}
      callout={failed ? t("notCompleted.callout") : t("noOptions.callout")}
      calloutTone="warning"
      reference={ref(vm)}
      actions={
        <Button fullWidth onClick={failed ? c.actions.retry : c.actions.back} data-testid={failed ? "retry" : "other"}>
          {t("noOptions.action")}
        </Button>
      }
    />
  );
}

export function QuoteExpiredScreen({ c, vm }: { c: Checkout; vm: ViewModel }) {
  const open = c.state.session?.status === "open";
  return (
    <StateScreen
      testId="quote-expired"
      icon={<ClockIcon />}
      title={t("quote.title")}
      body={t("quote.body")}
      badge={t("quote.badge")}
      callout={t("quote.callout")}
      reference={ref(vm)}
      actions={
        <>
          {open ? (
            <Button fullWidth onClick={c.actions.retry} data-testid="new-address">
              {t("quote.new")}
            </Button>
          ) : null}
          <Button fullWidth variant={open ? "secondary" : "primary"} onClick={() => void c.actions.refresh()}>
            {t("app.checkStatus")}
          </Button>
        </>
      }
    />
  );
}

export function AddressExpiredScreen({ c, vm }: { c: Checkout; vm: ViewModel }) {
  const open = c.state.session?.status === "open";
  return (
    <StateScreen
      testId="expired-address"
      icon={<WarningIcon />}
      title={t("expired.title")}
      body={
        <>
          <strong className="ck-strong">{t("deposit.expired")}</strong> {t("expired.body")}
        </>
      }
      callout={t("expired.callout")}
      calloutTone="warning"
      reference={ref(vm)}
      actions={
        <>
          {open ? (
            <Button fullWidth onClick={c.actions.retry} data-testid="new-address">
              {t("expired.newAddress")}
            </Button>
          ) : null}
          <Button fullWidth variant={open ? "secondary" : "primary"} onClick={() => void c.actions.refresh()}>
            {t("app.checkPaymentStatus")}
          </Button>
        </>
      }
    />
  );
}

export function ProcessingScreen({
  c,
  vm,
  variant,
}: {
  c: Checkout;
  vm: ViewModel;
  variant: "waiting" | "confirming" | "slow";
}) {
  const title =
    variant === "waiting" ? t("waiting.title") : variant === "slow" ? t("slow.title") : t("confirming.title");
  const body = variant === "waiting" ? t("waiting.body") : variant === "slow" ? t("slow.body") : t("confirming.body");
  return (
    <StateScreen
      testId="processing"
      icon={<ClockIcon />}
      title={title}
      body={body}
      badge={variant === "waiting" ? t("waiting.badge") : t("confirming.badge")}
      callout={variant === "slow" ? t("slow.callout") : t("confirming.callout")}
      reference={ref(vm)}
      actions={
        <>
          {variant === "slow" ? (
            <Button fullWidth onClick={() => void c.actions.refresh()} data-testid="check-status">
              {t("app.checkStatus")}
            </Button>
          ) : (
            <Button fullWidth loading loadingText={t("confirming.button")}>
              {t("confirming.button")}
            </Button>
          )}
          {c.streamMode === "polling" ? <p className="np-checkout__note">{t("app.liveStatusPolling")}</p> : null}
        </>
      }
    />
  );
}

export function UnderReviewScreen({ vm }: { vm: ViewModel }) {
  return (
    <StateScreen
      testId="review"
      icon={<ShieldCheckIcon />}
      title={t("underReview.title")}
      body={t("underReview.body")}
      badge={t("underReview.badge")}
      callout={t("underReview.callout")}
      reference={ref(vm)}
      actions={
        vm.reference ? (
          <CopyTextButton
            value={vm.reference}
            label={t("app.copyReference")}
            copiedLabel={t("app.referenceCopied")}
            failedLabel={t("app.copyFailed", { ref: vm.reference })}
            testId="copy-reference"
          />
        ) : null
      }
    />
  );
}

export function CompleteScreen({
  vm,
  paid,
  returnTo,
  redirecting,
  actions,
}: {
  vm: ViewModel;
  /** Attested amount + network of the payment made in this page load. */
  paid: { amount: string; chain: string } | null;
  /** Hosted: validated success URL. */
  returnTo: string | null;
  redirecting: boolean;
  /** Actions when there is no success URL (hosted invoices: "View invoice"). */
  actions?: ReactNode;
}) {
  const merchant = vm.merchant?.name ?? null;
  return (
    <StateScreen
      testId="succeeded"
      icon={<CheckIcon />}
      title={t("complete.title")}
      body={merchant ? t("complete.body", { merchant }) : t("complete.bodyUnknown")}
      badge={t("complete.badge")}
      callout={paid ? t("complete.paid", paid) : t("complete.paidUnknown")}
      reference={ref(vm)}
      actions={
        returnTo ? (
          <>
            <a className={buttonClassName({ fullWidth: true })} href={returnTo} data-testid="continue-merchant">
              {merchant ? t("complete.return", { merchant }) : t("complete.returnUnknown")}
            </a>
            {redirecting ? (
              <p className="np-checkout__note" role="status">
                {t("complete.redirect")}
              </p>
            ) : null}
          </>
        ) : (
          (actions ?? null)
        )
      }
    />
  );
}

export function ReturnScreen({ c, vm, done }: { c: Checkout; vm: ViewModel; done: boolean }) {
  const a = c.state.attempt;
  const open = c.state.session?.status === "open";
  const amount = a?.refunded_amount ? assetMoney(a.refunded_amount, c.assetMeta) : null;
  return (
    <StateScreen
      testId="refunded"
      icon={done ? <CheckIcon /> : <ArrowRightIcon />}
      title={done ? t("returned.title") : t("returning.title")}
      body={done ? t("returned.body") : t("returning.body")}
      badge={done ? undefined : t("returning.badge")}
      callout={done ? t("returned.callout") : t("returning.callout")}
      reference={ref(vm)}
      actions={
        <>
          {done ? null : (
            <Button fullWidth onClick={() => void c.actions.refresh()}>
              {t("app.checkStatus")}
            </Button>
          )}
          {done && open ? (
            <Button fullWidth onClick={c.actions.retry} data-testid="retry">
              {t("returned.retry")}
            </Button>
          ) : null}
        </>
      }
    >
      {done && a?.refunded_amount ? (
        <div>
          <KeyValueList
            items={[
              {
                label: t("returned.amount"),
                value: (
                  <span data-testid="refunded-amount">
                    {amount ? <Money {...amount} /> : `${a.refunded_amount} base units`}
                  </span>
                ),
              },
            ]}
          />
          <p className="np-checkout__note">{t("returned.note")}</p>
        </div>
      ) : null}
    </StateScreen>
  );
}

function shortRef(r: string): string {
  return r.length > 18 ? `${r.slice(0, 9)}…${r.slice(-4)}` : r;
}
