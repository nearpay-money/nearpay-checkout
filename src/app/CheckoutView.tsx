/**
 * Renders the checkout for the current machine phase inside the ui `CheckoutFrame` (shared by hosted and
 * embedded mode). The phase → Figma frame mapping is `screenFor` (screens.ts); this file wires the
 * frame (merchant, amount hero, order summary, test-mode banner, back) and the per-screen UI state
 * (search, refund address, Turnstile token, the "still confirming" timer).
 *
 * Design v2: from 960 px the hosted page is the split layout — the navy order side (attested merchant,
 * item, amount, line items with "You send", "How your payment travels") and the white pay side; below
 * it one column with the order summary collapsed into a header + "Order details" (`OrderHeader`).
 */
import { Callout, CheckoutFrame, type KeyValueItem, Money, Skeleton } from "@nearpay-internal/ui";
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { webLinks } from "../config";
import { optionKey, optionNetwork } from "../features/asset-picker/options";
import { estimateText } from "../features/asset-picker/tokens";
import { ManualInstructions } from "../features/deposit-instructions/ManualInstructions";
import { VerifiedMerchant } from "../features/deposit-instructions/PaymentDetails";
import { WalletPay } from "../features/deposit-instructions/WalletPay";
import { SendFromAnotherWallet } from "../features/refund-address/SendFromAnotherWallet";
import { TurnstileWidget } from "../features/wallet-connect/TurnstileWidget";
import { StartScreen, WalletConnect } from "../features/wallet-connect/WalletConnect";
import { errorText, t } from "../lib/i18n/t";
import { assetMoney } from "../lib/money/display";
import { useMediaQuery } from "../ui/useMediaQuery";
import type { Option } from "./machine";
import { buildModel, instructionsNetwork, moneyText, type ViewModel } from "./model";
import { AmountWithLabel, OrderHeader, OrderLines, PaymentRoute, routeFrom, WIDE_QUERY } from "./OrderSummary";
import {
  AddressExpiredScreen,
  BlockedScreen,
  CompleteScreen,
  LoadingScreen,
  NoOptionsScreen,
  ProcessingScreen,
  QuoteExpiredScreen,
  ReturnScreen,
  UnderReviewScreen,
  VerifyFailedScreen,
  VerifyingScreen,
} from "./StatusScreens";
import { canGoBack, INSUFFICIENT_FUNDS, type ScreenId, screenFor } from "./screens";
import type { Checkout } from "./useCheckout";

/**
 * "Pay with" (network + token dropdowns, balance logic) is a lazy chunk (§7 initial-JS budget): it is
 * never the first screen, and it is prefetched while "Pay your way" / "Connect a wallet" show.
 */
const loadPayWith = () => import("../features/asset-picker/PayWith");
const PayWith = lazy(() => loadPayWith().then((m) => ({ default: m.PayWith })));

function PayWithFallback() {
  return (
    <div className="np-stack" aria-busy="true" data-testid="pay-with-loading">
      <Skeleton shape="title" />
      <Skeleton shape="block" />
      <Skeleton shape="block" />
    </div>
  );
}

/** "Still confirming" after this long in `processing` with a detected deposit. */
export const SLOW_AFTER_MS = 120_000;

const SCREEN_ERRORS = new Set(["wallet_rejected", INSUFFICIENT_FUNDS]);
/** Screens that show verified instructions (and with them the attested merchant + Payment details). */
const TRUST_SCREENS = new Set<ScreenId>(["review", "review_updated", "test_payment", "send_manual", "received_less"]);

function errorMessage(code: string, param?: string | null): string {
  if (code === "wallet_rejected") return t("wallet.rejected");
  if (code === "wallet_failed") return t("wallet.failed", { message: param ?? "" });
  return errorText(code);
}

export interface CheckoutViewProps {
  c: Checkout;
  mode: "hosted" | "embed";
  /** Hosted: validated success URL for "Return to <merchant>". */
  returnTo?: string | null;
  redirecting?: boolean;
  /** Hosted: validated cancel URL (topbar Back on the first screen). */
  cancelUrl?: string | null;
  /** Hosted: in-app cancel (topbar Back on the first screen), e.g. "Back to invoice". */
  onCancel?: (() => void) | null;
  /** Extra actions under the flow (embedded: Close). */
  extra?: ReactNode;
  /**
   * Desktop order summary head replacing the description + Subtotal rows (hosted invoices: the invoice
   * lines and totals); the attested Payment fees / Total to send rows still follow it.
   */
  summaryHead?: ReactNode;
  /** Actions of "Payment complete" when there is no success URL to return to (hosted invoices). */
  completeActions?: ReactNode;
  /** Replaces the generic blocked screen for some reasons (hosted invoices: expired session). */
  renderBlocked?: (reason: NonNullable<Checkout["state"]["blockReason"]>) => ReactNode | null;
  /** Hosted: the merchant's site (return URL host), shown under the attested merchant name. */
  site?: string | null;
}

export function CheckoutView({
  c,
  mode,
  returnTo = null,
  redirecting = false,
  cancelUrl = null,
  onCancel = null,
  extra,
  summaryHead,
  completeActions,
  renderBlocked,
  site = null,
}: CheckoutViewProps) {
  const { state, actions, busy } = c;
  const switchToManual = actions.useManual;
  const wide = useMediaQuery(WIDE_QUERY);
  const vm = useMemo(() => buildModel(c), [c]);
  const [refund, setRefund] = useState("");
  const [manualForm, setManualForm] = useState(false);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  /** Token to preselect on the manual path after "Pay from another wallet or exchange" (fee warning). */
  const [preferKey, setPreferKey] = useState<string | null>(null);
  /** Wallet balances read by "Pay with" (formatted, by option key), for the review's token card. */
  const [balances, setBalances] = useState<ReadonlyMap<string, string>>(new Map());
  const onBalances = useCallback(
    (b: ReadonlyMap<string, string>) => setBalances((prev) => new Map([...prev, ...b])),
    [],
  );
  /** The option chosen in the "Pay with" dropdowns (before Continue), shown on the order side. */
  const [choice, setChoice] = useState<Option | null>(null);

  // The network-fee pre-check runs while `busy` but before any wallet prompt: stay on the review.
  const screen = screenFor(state, {
    manualForm,
    busy: busy && !c.preparing,
    slow,
    totalChanged: c.previousTotal !== null,
  });

  // ---- wallet path: tapping an option prepares the payment once the human check has a token ----------
  const { phase, path, option, error } = state;
  const confirm = actions.confirm;
  useEffect(() => {
    if (phase !== "choose_asset" || path !== "wallet" || !pendingKey || !token || busy) return;
    if (!option || optionKey(option) !== pendingKey) return;
    setToken(null); // one token per attempt
    void confirm({ turnstileToken: token });
  }, [phase, path, pendingKey, token, busy, option, confirm]);

  useEffect(() => {
    if (phase !== "choose_asset" || error) setPendingKey(null);
    // The refund form survives attempt creation (a failed attempt returns to it with the error).
    if (phase !== "choose_asset" && phase !== "confirming") setManualForm(false);
  }, [phase, error]);

  // Wallet re-quote ("Get a new quote"): pick the same option again; the review shows any change.
  const requoted = useRef<string | null>(null);
  const select = actions.selectOption;
  useEffect(() => {
    const key = c.requoteKey;
    if (phase !== "choose_asset" || !key || requoted.current === key || !state.options) return;
    requoted.current = key;
    const o = state.options.find((x) => optionKey(x) === key && x.available);
    if (o) {
      select(o);
      setPendingKey(key);
    }
  }, [phase, c.requoteKey, state.options, select]);

  // Prefetch the "Pay with" chunk before it is needed.
  useEffect(() => {
    if (screen === "start" || screen === "connect_wallet") void loadPayWith().catch(() => undefined);
  }, [screen]);

  // ---- "Still confirming" ---------------------------------------------------------------------------
  const confirmingScreen = screen === "confirming" || screen === "still_confirming";
  useEffect(() => {
    if (!confirmingScreen) {
      setSlow(false);
      return;
    }
    const id = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(id);
  }, [confirmingScreen]);

  // ---- the attested amount of the payment made in this page load (Payment complete callout) ----------
  const paid = useRef<{ amount: string; chain: string } | null>(null);
  if (vm.total && state.verified) {
    paid.current = {
      amount: moneyText(assetMoney(vm.total, vm.asset), `${vm.total} base units`),
      chain: instructionsNetwork(c),
    };
  }

  // ---- focus: after a step change that removed the focused control, move focus to the new title ------
  const lastScreen = useRef(screen);
  useEffect(() => {
    if (lastScreen.current === screen) return;
    const from = lastScreen.current;
    lastScreen.current = screen;
    if (from === "loading") return; // first paint: leave focus at the document start
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const h = document.querySelector<HTMLElement>(".ck-flow .ck-screen h1");
    if (h) {
      h.setAttribute("tabindex", "-1");
      h.focus({ preventScroll: true });
    }
  }, [screen]);

  const turnstileKey = `${state.attempt?.id ?? "first"}:${error?.code ?? ""}`;
  const needsToken = state.phase === "choose_asset";

  const body = (() => {
    switch (screen) {
      case "loading":
        return <LoadingScreen />;
      case "blocked":
        return (
          renderBlocked?.(state.blockReason ?? "load_failed") ?? (
            <BlockedScreen reason={state.blockReason ?? "load_failed"} />
          )
        );
      case "start":
        return (
          <StartScreen
            embedded={mode === "embed"}
            onWallet={() => actions.choosePath("wallet")}
            onManual={() => actions.choosePath("manual")}
          />
        );
      case "connect_wallet":
        return <WalletConnect onConnected={actions.connected} onCancel={actions.back} onManual={actions.useManual} />;
      case "pay_with":
        return (
          <Suspense fallback={<PayWithFallback />}>
            <PayWith
              options={state.options}
              wallet={state.wallet}
              pendingKey={pendingKey}
              busy={busy}
              needsChallenge={pendingKey !== null && token === null && !busy}
              walletReads={c.walletReads}
              preferKey={preferKey}
              onBalances={onBalances}
              onChoice={setChoice}
              merchantReceives={vm.price ? <Money {...vm.price} /> : vm.priceText}
              wide={wide}
              onPick={(o) => {
                setPreferKey(null);
                actions.selectOption(o);
                if (state.path === "manual") setManualForm(true);
                else setPendingKey(optionKey(o));
              }}
            />
          </Suspense>
        );
      case "no_options":
        return <NoOptionsScreen c={c} vm={vm} />;
      case "send_from_another_wallet":
        return state.option ? (
          <SendFromAnotherWallet
            option={state.option}
            refund={refund}
            onRefund={setRefund}
            canSubmit={token !== null}
            busy={busy}
            needsChallenge={token === null}
            onChange={() => setManualForm(false)}
            onSubmit={(refundTo) => {
              if (!token) return;
              setToken(null);
              void actions.confirm({ refundTo, turnstileToken: token });
            }}
          />
        ) : null;
      case "verifying":
        return <VerifyingScreen vm={vm} />;
      case "verify_failed":
        return <VerifyFailedScreen c={c} vm={vm} />;
      case "review":
      case "review_updated":
      case "test_payment":
      case "approve_in_wallet":
      case "not_approved":
      case "not_enough_funds":
      case "tx_failed":
        return (
          <WalletPay
            c={c}
            vm={vm}
            screen={screen}
            wide={wide}
            balance={state.option ? (balances.get(optionKey(state.option)) ?? null) : null}
            onManual={() => {
              setPreferKey(state.option ? optionKey(state.option) : null);
              switchToManual();
            }}
          />
        );
      case "send_manual":
      case "received_less":
        return <ManualInstructions c={c} vm={vm} topUp={screen === "received_less"} />;
      case "address_expired":
        return <AddressExpiredScreen c={c} vm={vm} />;
      case "quote_expired":
        return <QuoteExpiredScreen c={c} vm={vm} />;
      case "waiting":
        return <ProcessingScreen c={c} vm={vm} variant="waiting" />;
      case "confirming":
        return <ProcessingScreen c={c} vm={vm} variant="confirming" />;
      case "still_confirming":
        return <ProcessingScreen c={c} vm={vm} variant="slow" />;
      case "under_review":
        return <UnderReviewScreen vm={vm} />;
      case "complete":
        return (
          <CompleteScreen
            vm={vm}
            paid={c.trusted ? paid.current : null}
            returnTo={returnTo}
            redirecting={redirecting}
            actions={completeActions}
          />
        );
      case "being_returned":
        return <ReturnScreen c={c} vm={vm} done={false} />;
      case "returned":
        return <ReturnScreen c={c} vm={vm} done />;
      case "not_completed":
        return <NoOptionsScreen c={c} vm={vm} failed />;
    }
  })();

  // ---- frame -------------------------------------------------------------------------------------------
  const onBack = (() => {
    if (busy) return undefined;
    if (screen === "send_from_another_wallet") return () => setManualForm(false);
    if (canGoBack(state)) return actions.back;
    if (screen === "start" && onCancel) return onCancel;
    if (screen === "start" && cancelUrl) return () => window.location.assign(cancelUrl);
    return undefined;
  })();
  const merchant = vm.merchant && state.phase !== "verify_failed" ? vm.merchant : null;
  const loaded = state.session !== null;
  const priceNode = vm.price ? <Money {...vm.price} size="hero" /> : vm.priceText;
  const showError = state.error && !(state.phase === "pay_wallet" && SCREEN_ERRORS.has(state.error.code));
  // Route: the attested token and network once verified, else the option picked, else the one being chosen.
  const chosen = option ?? (screen === "pay_with" ? choice : null);
  const routeToken = state.verified ? (vm.asset?.symbol ?? option?.symbol ?? null) : (chosen?.symbol ?? null);
  const from = state.verified
    ? routeFrom(routeToken, instructionsNetwork(c))
    : chosen
      ? routeFrom(chosen.symbol, optionNetwork(chosen))
      : null;
  // Before the instructions are attested, "You send" is the chosen option's indicative amount.
  const estimate = screen === "pay_with" && choice ? estimateText(choice) : null;
  const order: OrderParts | null = loaded
    ? {
        // "Review your updated total" carries the total itself.
        lines: orderLines(vm, wide && screen !== "review_updated", summaryHead, estimate),
        route: <PaymentRoute from={from} token={routeToken} merchant={merchant?.name ?? null} />,
      }
    : null;
  const navy = mode === "hosted";

  return (
    <CheckoutFrame
      variant={mode === "embed" ? "embed" : "page"}
      merchant={wide && merchant ? { name: merchant.name, ...(site ? { subtitle: site } : {}) } : undefined}
      amount={
        wide && loaded ? (
          <AmountWithLabel
            label={summaryHead ? null : vm.description}
            amount={<span data-testid="price">{priceNode}</span>}
          />
        ) : undefined
      }
      onBack={onBack}
      summary={
        wide && order ? (
          <>
            {order.lines}
            {order.route}
          </>
        ) : undefined
      }
      banner={
        vm.testMode ? (
          <Callout tone="info" title={t("app.testmode")} reference={t("app.testmodeRef")} data-testid="test-banner" />
        ) : undefined
      }
      securedLabel={t("app.poweredBy")}
      links={mode === "hosted" ? webLinks : {}}
      className={mode === "embed" ? "ck-frame ck-frame--embed" : "ck-frame"}
    >
      {!wide && order ? (
        <OrderHeader
          merchant={merchant?.name ?? null}
          site={site}
          title={vm.description}
          amount={<span data-testid="price">{priceNode}</span>}
          details={
            <>
              {order.lines}
              {order.route}
            </>
          }
          navy={navy}
        />
      ) : null}
      <div className="ck-flow" aria-busy={busy || undefined}>
        {showError && state.error ? (
          <Callout tone="danger" title={errorMessage(state.error.code, state.error.param)} live data-testid="error" />
        ) : null}
        {TRUST_SCREENS.has(screen) && state.verified ? <VerifiedMerchant vm={vm} /> : null}
        {body}
        {needsToken ? <TurnstileWidget onToken={setToken} resetKey={turnstileKey} /> : null}
        {extra}
      </div>
    </CheckoutFrame>
  );
}

interface OrderParts {
  readonly lines: ReactNode;
  readonly route: ReactNode;
}

/**
 * Line items: the item (description, else "Purchase") at the price, then — once the instructions are
 * attested — Payment fees and "You send" (the attested total); on "Pay with", with a token chosen, Payment
 * fees "Included" and "You send about <indicative amount>"; otherwise the Total is the price.
 * Hosted invoices replace the item row with the compact invoice (`head`). With `totalId` (desktop) "You
 * send" carries the `total-to-send` value (phones show it on the review card instead).
 */
function orderLines(vm: ViewModel, totalId: boolean, head?: ReactNode, estimate: string | null = null): ReactNode {
  const price = vm.price ? <Money {...vm.price} /> : vm.priceText;
  const total = vm.total ? assetMoney(vm.total, vm.asset) : null;
  const items: KeyValueItem[] = head ? [] : [{ label: vm.description ?? t("summary.purchase"), value: price }];
  if (vm.total) {
    items.push({
      label: t("summary.fees"),
      value:
        vm.fee === "0" ? (
          t("summary.feesNone")
        ) : vm.fee ? (
          <Money {...(assetMoney(vm.fee, vm.asset) ?? { amount: vm.fee, decimals: 0 })} />
        ) : (
          t("summary.feesIncluded")
        ),
    });
    const sent = total ? <Money {...total} /> : `${vm.total} base units`;
    items.push({
      label: t("summary.youSend"),
      value: totalId ? <span data-testid="total-to-send">{sent}</span> : sent,
      total: true,
    });
  } else if (estimate) {
    // "Pay with": the indicative amount of the chosen token (fees included), never presented as exact.
    items.push({ label: t("summary.fees"), value: t("summary.feesIncluded") });
    const about = t("asset.youSendAbout", { amount: estimate });
    items.push({
      label: t("summary.youSend"),
      value: totalId ? <span data-testid="selected-estimate">{about}</span> : about,
      total: true,
    });
  } else if (!head) {
    items.push({ label: t("summary.total"), value: price, total: true });
  }
  return (
    <>
      {head}
      {items.length > 0 ? <OrderLines items={items} /> : null}
    </>
  );
}
