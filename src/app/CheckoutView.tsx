/**
 * Renders the checkout for the current machine phase inside the ui `CheckoutFrame` (shared by hosted and
 * embedded mode). The phase → Figma frame mapping is `screenFor` (screens.ts); this file wires the
 * frame (merchant, amount hero, desktop summary, test-mode banner, back) and the per-screen UI state
 * (search, refund address, Turnstile token, the "still confirming" timer).
 */
import { Callout, CheckoutFrame, KeyValueList, Money } from "@nearpay-internal/ui";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { webLinks } from "../config";
import { optionKey } from "../features/asset-picker/options";
import { PayWith } from "../features/asset-picker/PayWith";
import { ManualInstructions } from "../features/deposit-instructions/ManualInstructions";
import { TrustRow } from "../features/deposit-instructions/PaymentDetails";
import { WalletPay } from "../features/deposit-instructions/WalletPay";
import { SendFromAnotherWallet } from "../features/refund-address/SendFromAnotherWallet";
import { TurnstileWidget } from "../features/wallet-connect/TurnstileWidget";
import { StartScreen, WalletConnect } from "../features/wallet-connect/WalletConnect";
import { errorText, t } from "../lib/i18n/t";
import { assetMoney } from "../lib/money/display";
import { useMediaQuery } from "../ui/useMediaQuery";
import { buildModel, instructionsNetwork, moneyText, type ViewModel } from "./model";
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
  /** Extra actions under the flow (embedded: Close). */
  extra?: ReactNode;
}

export function CheckoutView({
  c,
  mode,
  returnTo = null,
  redirecting = false,
  cancelUrl = null,
  extra,
}: CheckoutViewProps) {
  const { state, actions, busy } = c;
  const wide = useMediaQuery("(min-width: 880px)");
  const vm = useMemo(() => buildModel(c), [c]);
  const [refund, setRefund] = useState("");
  const [manualForm, setManualForm] = useState(false);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);

  const screen = screenFor(state, { manualForm, busy, slow, totalChanged: c.previousTotal !== null });

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
    const h = document.querySelector<HTMLElement>(".ck-screen h1");
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
        return <BlockedScreen reason={state.blockReason ?? "load_failed"} />;
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
          <PayWith
            options={state.options}
            wallet={state.wallet}
            pendingKey={pendingKey}
            busy={busy}
            needsChallenge={pendingKey !== null && token === null && !busy}
            onPick={(o) => {
              actions.selectOption(o);
              if (state.path === "manual") setManualForm(true);
              else setPendingKey(optionKey(o));
            }}
          />
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
        return <WalletPay c={c} vm={vm} screen={screen} wide={wide && mode === "hosted"} />;
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
    if (screen === "start" && cancelUrl) return () => window.location.assign(cancelUrl);
    return undefined;
  })();
  const merchant = vm.merchant && state.phase !== "verify_failed" ? vm.merchant : null;
  const amount = state.session ? (
    <span data-testid="price">{vm.price ? <Money {...vm.price} size="hero" /> : vm.priceText}</span>
  ) : null;
  const showError = state.error && !(state.phase === "pay_wallet" && SCREEN_ERRORS.has(state.error.code));

  return (
    <CheckoutFrame
      variant={mode === "embed" ? "embed" : "page"}
      merchant={merchant ? { name: merchant.name, ...(vm.description ? { subtitle: vm.description } : {}) } : undefined}
      amount={amount}
      onBack={onBack}
      summary={summaryFor(vm, wide, merchant !== null, state.session !== null)}
      banner={
        vm.testMode ? (
          <Callout tone="info" title={t("app.testmode")} reference={t("app.testmodeRef")} data-testid="test-banner" />
        ) : undefined
      }
      links={mode === "hosted" ? webLinks : {}}
      className={mode === "embed" ? "ck-frame ck-frame--embed" : "ck-frame"}
    >
      <div className="ck-flow" aria-busy={busy || undefined}>
        {showError && state.error ? (
          <Callout tone="danger" title={errorMessage(state.error.code, state.error.param)} live data-testid="error" />
        ) : null}
        {TRUST_SCREENS.has(screen) ? <TrustRow vm={vm} /> : null}
        {body}
        {needsToken ? <TurnstileWidget onToken={setToken} resetKey={turnstileKey} /> : null}
        {extra}
      </div>
    </CheckoutFrame>
  );
}

/**
 * Order summary: on desktop (two columns) the description and the Subtotal / Payment fees / Total rows;
 * on phones only the description, and only while no attested merchant subtitle carries it.
 */
function summaryFor(vm: ViewModel, wide: boolean, hasMerchant: boolean, loaded: boolean): ReactNode {
  if (!loaded) return undefined;
  if (!wide) {
    return !hasMerchant && vm.description ? (
      <p className="np-checkout__lede" data-testid="description">
        {vm.description}
      </p>
    ) : undefined;
  }
  const total = vm.total ? assetMoney(vm.total, vm.asset) : null;
  return (
    <>
      {vm.description ? (
        <h2 className="ck-summary-title" data-testid="description">
          {vm.description}
        </h2>
      ) : null}
      <hr className="np-divider" />
      <KeyValueList
        items={[
          { label: t("summary.subtotal"), value: vm.price ? <Money {...vm.price} /> : vm.priceText },
          ...(vm.total
            ? [
                {
                  label: t("summary.fees"),
                  value:
                    vm.fee === "0" ? (
                      t("summary.feesNone")
                    ) : vm.fee ? (
                      <Money {...(assetMoney(vm.fee, vm.asset) ?? { amount: vm.fee, decimals: 0 })} />
                    ) : (
                      t("summary.feesIncluded")
                    ),
                },
                {
                  label: t("summary.totalToSend"),
                  value: total ? <Money {...total} /> : `${vm.total} base units`,
                  total: true,
                },
              ]
            : []),
        ]}
      />
    </>
  );
}
