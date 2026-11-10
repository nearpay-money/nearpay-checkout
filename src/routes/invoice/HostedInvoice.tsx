/**
 * Hosted invoice `/i/<in_…>#<invoice secret>` (Stage 3; lld/checkout-and-js.md §4.3, lld/billing.md §5,
 * §11 d3; Figma "Invoice INV-2041" mobile frame). The invoice secret comes from the URL fragment, stays in
 * memory and travels only in `X-NearPay-Invoice-Secret` (never in a URL, log or referrer; the fragment is
 * left in the address bar so a reload keeps working, as §5.1).
 *
 * - `getPublicInvoice` (read-only) renders the invoice: number, status, dates, bill-to, lines, taxes,
 *   totals, memo, footer, PDF download (`getPublicInvoicePdf`).
 * - "Pay invoice" / "Continue payment" calls `createPublicInvoiceSession` (create or continue the
 *   invoice's checkout session) and hands off IN PLACE to the unchanged checkout flow (`useCheckout` +
 *   `CheckoutView`): every checkout security rule (sentinel verification before any address or wallet
 *   prompt, field equality, deadlines, manual-path guards, test mode never broadcasts) applies as is.
 * - A wrong secret, an unknown id and a malformed link all show the same "Invoice not found" (no oracle).
 * - The invoice's `merchant_name_unverified` is never rendered (L-CK-03): the attested merchant appears
 *   once a payment attempt is verified, as in every checkout.
 */
import {
  createPublicInvoiceSession,
  getPublicInvoice,
  getPublicInvoicePdf,
  type InvoicePaymentSession,
} from "@nearpay/spec";
import {
  Button,
  Callout,
  CheckoutFrame,
  ClockIcon,
  type KeyValueItem,
  KeyValueList,
  LiveRegion,
  Money,
  StatusBadge,
  WarningIcon,
} from "@nearpay-internal/ui";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { CheckoutView } from "../../app/CheckoutView";
import { WIDE_QUERY } from "../../app/OrderSummary";
import { linkSessionPath } from "../../app/route";
import { LoadingScreen } from "../../app/StatusScreens";
import { useCheckout } from "../../app/useCheckout";
import { webLinks } from "../../config";
import { call, callBinary, isApiError } from "../../lib/api/client";
import { errorText, t } from "../../lib/i18n/t";
import { StateScreen } from "../../ui/blocks";
import { useMediaQuery } from "../../ui/useMediaQuery";
import { AutoPayEntry, AutoPayManage, AutoPaySetup } from "./autopay/AutoPay";
import {
  billToText,
  formatDate,
  formatPeriod,
  heroAmount,
  type Invoice,
  type InvoiceStatusView,
  invoiceMoney,
  invoiceStatus,
  isZero,
  pdfFilename,
  rawAmount,
  taxLabelKey,
} from "./model";

/** After a payment completes in this page, re-read the invoice until billing reports it paid. */
export const PAID_POLL_MS = 2000;
export const PAID_POLL_MAX = 30;

type Session = { readonly id: string; readonly secret: string };
/** The payment made in this page load (attested merchant + payment reference). */
type JustPaid = { readonly merchant: string | null; readonly reference: string | null };

type PageState =
  | { readonly kind: "loading" }
  | { readonly kind: "not_found" }
  | { readonly kind: "load_failed"; readonly code: string }
  | { readonly kind: "ready"; readonly invoice: Invoice }
  | { readonly kind: "paying"; readonly invoice: Invoice; readonly session: Session }
  /** Auto-pay setup or management (Stage 4, §4.4), in place like the payment flow. */
  | { readonly kind: "autopay"; readonly invoice: Invoice; readonly view: "setup" | "manage" };

const NOT_FOUND = new Set(["invoice_secret_invalid", "resource_missing"]);

function isNotFound(e: unknown): boolean {
  return isApiError(e) && (NOT_FOUND.has(e.code) || e.status === 404 || e.status === 401);
}

export function HostedInvoice({ id, secret }: { id: string; secret: string }) {
  const [st, setSt] = useState<PageState>({ kind: "loading" });
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justPaid, setJustPaid] = useState<JustPaid | null>(null);

  const load = useCallback(
    async (quiet = false): Promise<Invoice | null> => {
      if (!quiet) setSt({ kind: "loading" });
      try {
        const invoice = await call(getPublicInvoice, { params: { id }, invoiceSecret: secret });
        setSt((cur) => (cur.kind === "paying" || cur.kind === "autopay" ? cur : { kind: "ready", invoice }));
        return invoice;
      } catch (e) {
        if (isNotFound(e)) setSt({ kind: "not_found" });
        else if (!quiet) setSt({ kind: "load_failed", code: isApiError(e) ? e.code : "generic" });
        return null;
      }
    },
    [id, secret],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const invoice = st.kind === "ready" || st.kind === "paying" || st.kind === "autopay" ? st.invoice : null;
  useEffect(() => {
    document.title = invoice ? t("invoice.pageTitle", { number: invoice.number }) : t("app.title");
  }, [invoice]);

  // After a payment in this page: poll until billing has recorded it (the invoice event follows the
  // payment intent's). Pay stays hidden meanwhile so the payer is never invited to pay twice.
  const paidNow = justPaid !== null && st.kind === "ready" && st.invoice.status !== "paid";
  useEffect(() => {
    if (!paidNow) return;
    let n = 0;
    const timer = setInterval(() => {
      n++;
      void load(true).then((inv) => {
        if (inv?.status === "paid" || n >= PAID_POLL_MAX) clearInterval(timer);
      });
    }, PAID_POLL_MS);
    return () => clearInterval(timer);
  }, [paidNow, load]);

  /** Create or continue the invoice's checkout session, then hand off to the checkout flow in place. */
  const openSession = async (inv: Invoice) => {
    setOpening(true);
    setError(null);
    try {
      const r: z.output<typeof InvoicePaymentSession> = await call(createPublicInvoiceSession, {
        params: { id },
        body: {},
        invoiceSecret: secret,
      });
      // The client secret must belong to the returned session (same check as `/c/` and payment links).
      if (!linkSessionPath(r.checkout_session, r.client_secret)) throw new Error("invalid session");
      setSt({ kind: "paying", invoice: inv, session: { id: r.checkout_session, secret: r.client_secret } });
    } catch (e) {
      if (isNotFound(e)) setSt({ kind: "not_found" });
      else if (isApiError(e, "invoice_not_payable")) {
        setError(errorText("invoice_not_payable"));
        void load(true);
      } else setError(isApiError(e) ? errorText(e.code) : errorText("invalid_response"));
    } finally {
      setOpening(false);
    }
  };

  const back = (paid: JustPaid | null = null) => {
    if (paid) setJustPaid(paid);
    setError(null);
    setSt((cur) => (cur.kind === "paying" || cur.kind === "autopay" ? { kind: "ready", invoice: cur.invoice } : cur));
    void load(true);
  };
  const toAutoPay = useCallback(
    (view: "setup" | "manage") =>
      setSt((cur) =>
        cur.kind === "ready" || cur.kind === "autopay" ? { kind: "autopay", invoice: cur.invoice, view } : cur,
      ),
    [],
  );
  const autoPayActive = useCallback(() => {
    toAutoPay("manage");
    void load(true);
  }, [toAutoPay, load]);

  /** "Start a new payment" after an expired session: re-read the invoice, then open a fresh session. */
  const restart = async (from: Invoice) => {
    setSt({ kind: "ready", invoice: from });
    setError(null);
    const inv = await load(true);
    if (inv && invoiceStatus(inv, Date.now()).payable) await openSession(inv);
  };

  useFocusTitle(st.kind);
  const wide = useMediaQuery(WIDE_QUERY);

  if (st.kind === "paying") {
    return (
      <InvoiceCheckout
        key={st.session.id}
        invoice={st.invoice}
        session={st.session}
        onBack={() => back()}
        onViewInvoice={(p) => back(p)}
        onRestart={() => void restart(st.invoice)}
      />
    );
  }

  if (st.kind === "autopay") {
    return (
      <AutoPayFrame invoice={st.invoice}>
        {st.view === "setup" ? (
          <AutoPaySetup invoice={st.invoice} secret={secret} onBack={() => back()} onActive={autoPayActive} />
        ) : (
          <AutoPayManage invoice={st.invoice} secret={secret} onBack={() => back()} />
        )}
      </AutoPayFrame>
    );
  }

  if (st.kind !== "ready") {
    return (
      <CheckoutFrame links={webLinks} securedLabel={t("app.poweredBy")} className="ck-frame">
        <div className="ck-flow">
          {st.kind === "loading" ? (
            <LoadingScreen label={t("invoice.loading")} />
          ) : st.kind === "not_found" ? (
            <NotFoundScreen />
          ) : (
            <StateScreen
              testId="invoice-load-failed"
              icon={<WarningIcon />}
              title={t("invoice.loadFailed")}
              body={errorText(st.code)}
              actions={
                <Button fullWidth onClick={() => void load()} data-testid="invoice-retry">
                  {t("invoice.retry")}
                </Button>
              }
            />
          )}
        </div>
      </CheckoutFrame>
    );
  }

  const inv = st.invoice;
  const view = invoiceStatus(inv, Date.now());
  const banner = InvoiceStatusCallout({ invoice: inv, view, justPaid });
  // Design v2: the document is the navy order side from 960 px; phones show it (on white) above the actions.
  return (
    <CheckoutFrame
      summary={wide ? <InvoiceDocument invoice={inv} view={view} /> : undefined}
      securedLabel={t("app.poweredBy")}
      banner={
        !inv.livemode || banner ? (
          <div className="np-stack np-stack--sm">
            {inv.livemode ? null : (
              <Callout
                tone="info"
                title={t("app.testmode")}
                reference={t("app.testmodeRef")}
                data-testid="test-banner"
              />
            )}
            {banner}
          </div>
        ) : undefined
      }
      links={webLinks}
      className="ck-frame ck-invoice"
      data-testid="invoice-page"
    >
      {wide ? null : <InvoiceDocument invoice={inv} view={view} />}
      <div className="ck-flow">
        <InvoiceActions
          invoice={inv}
          view={view}
          secret={secret}
          opening={opening}
          error={error}
          justPaid={justPaid}
          onPay={() => void openSession(inv)}
          onAutoPay={toAutoPay}
        />
      </div>
    </CheckoutFrame>
  );
}

function NotFoundScreen() {
  return (
    <StateScreen
      testId="invoice-not-found"
      icon={<WarningIcon />}
      title={t("invoice.notFoundTitle")}
      body={t("invoice.notFoundBody")}
    />
  );
}

/** Malformed `/i/` link (bad id, missing or foreign secret): identical to a wrong secret (no oracle). */
export function InvoiceNotFound() {
  return (
    <CheckoutFrame links={webLinks} securedLabel={t("app.poweredBy")} className="ck-frame">
      <div className="ck-flow">
        <NotFoundScreen />
      </div>
    </CheckoutFrame>
  );
}

// ---- the invoice document (summary column on desktop, top of the page on phones) ------------------

function Amount({ invoice, value, hero }: { invoice: Invoice; value: Invoice["total"]; hero?: boolean }) {
  const m = invoiceMoney(invoice, value);
  return m ? <Money {...m} {...(hero ? { size: "hero" as const } : {})} /> : rawAmount(value);
}

export function InvoiceDocument({
  invoice: inv,
  view,
  compact = false,
}: {
  invoice: Invoice;
  view: InvoiceStatusView;
  /** Desktop summary during payment: the frame already shows the amount hero. */
  compact?: boolean;
}) {
  const billTo = billToText(inv);
  const Title = compact ? "h2" : "h1";
  const dateLine =
    view.kind === "paid" && inv.paid_at
      ? t("invoice.paidOn", { date: formatDate(inv.paid_at) })
      : view.kind === "void" && inv.voided_at
        ? t("invoice.voidedOn", { date: formatDate(inv.voided_at) })
        : inv.due_date
          ? t("invoice.due", { date: formatDate(inv.due_date) })
          : t("invoice.dueNone");
  const meta: KeyValueItem[] = [
    ...(billTo ? [{ label: t("invoice.billTo"), value: <span data-testid="bill-to">{billTo}</span> }] : []),
    ...(compact ? [] : [{ label: t("invoice.issued"), value: formatDate(inv.issued_at) }]),
    ...(inv.period_start && inv.period_end
      ? [{ label: t("invoice.period"), value: formatPeriod(inv.period_start, inv.period_end) }]
      : []),
  ];
  return (
    <div className="ck-invoice-doc" data-testid="invoice-document">
      <div className="np-stack np-stack--sm">
        <Title className={compact ? "ck-summary-title" : "np-checkout__title"} id="ck-invoice-title">
          {t("invoice.docTitle", { number: inv.number })}
        </Title>
        {view.badge && !compact ? (
          <StatusBadge tone={view.badge.tone} data-testid="invoice-status">
            {t(view.badge.label)}
          </StatusBadge>
        ) : null}
      </div>
      {compact ? null : (
        <p className="np-checkout__amount" data-testid="invoice-amount">
          <Amount invoice={inv} value={heroAmount(inv, view.kind)} hero />
        </p>
      )}
      <p className="np-checkout__lede" data-testid="invoice-date">
        {dateLine}
      </p>
      {meta.length > 0 ? <KeyValueList items={meta} /> : null}
      {inv.display.description ? (
        <p className="ck-invoice-memo" data-testid="invoice-memo">
          {inv.display.description}
        </p>
      ) : null}
      <hr className="np-divider" />
      <ul className="ck-lines" aria-label={t("invoice.items")} data-testid="invoice-lines">
        {inv.lines.map((l, i) => (
          // Lines have no id on the public object; their order is fixed at finalize.
          // biome-ignore lint/suspicious/noArrayIndexKey: immutable, ordered list
          <li className="ck-line" key={i}>
            <span className="ck-line__desc">{l.description}</span>
            <span className="ck-line__amount">
              <Amount invoice={inv} value={l.amount} />
            </span>
            <span className="ck-line__meta">
              {l.quantity} × <Amount invoice={inv} value={l.unit_amount} />
              {l.period ? ` · ${formatPeriod(l.period.start, l.period.end)}` : ""}
            </span>
          </li>
        ))}
      </ul>
      <hr className="np-divider" />
      <InvoiceTotals invoice={inv} view={view} />
      {inv.display.footer && !compact ? (
        <p className="np-checkout__note ck-invoice-footer" data-testid="invoice-footer">
          {inv.display.footer}
        </p>
      ) : null}
    </div>
  );
}

function InvoiceTotals({ invoice: inv, view }: { invoice: Invoice; view: InvoiceStatusView }) {
  const a = (v: Invoice["total"]) => <Amount invoice={inv} value={v} />;
  const taxes: KeyValueItem[] =
    inv.total_tax_amounts.length > 0
      ? inv.total_tax_amounts.map((x) => ({
          label: t(taxLabelKey(x.inclusive), { name: x.display_name, rate: x.percentage }),
          value: a(x.amount),
        }))
      : [{ label: t("invoice.tax"), value: a(inv.tax) }];
  const paid = !isZero(inv.amount_paid);
  const open = view.kind === "open" || view.kind === "uncollectible";
  const items: KeyValueItem[] = [
    { label: t("invoice.subtotal"), value: a(inv.subtotal) },
    ...taxes,
    ...(paid || !open ? [{ label: t("invoice.total"), value: a(inv.total), total: !open && !paid }] : []),
    ...(paid ? [{ label: t("invoice.amountPaid"), value: a(inv.amount_paid), total: !open }] : []),
    ...(open
      ? [
          {
            label: paid ? t("invoice.amountRemaining") : t("invoice.amountDue"),
            value: <span data-testid="amount-due">{a(inv.amount_remaining)}</span>,
            total: true,
          },
        ]
      : []),
  ];
  return <KeyValueList items={items} />;
}

/**
 * The invoice's status message (overdue, past due, not payable, paid, void, updating): shown in the
 * frame's banner slot, above the invoice on phones and across both columns on desktop.
 */
function InvoiceStatusCallout({
  invoice: inv,
  view,
  justPaid,
}: {
  invoice: Invoice;
  view: InvoiceStatusView;
  justPaid: JustPaid | null;
}) {
  const due = inv.due_date ? formatDate(inv.due_date) : "";
  const updating = justPaid !== null && view.kind !== "paid";
  const reference = justPaid?.reference ? t("app.reference", { ref: justPaid.reference }) : undefined;
  let status: ReactNode = null;
  if (updating) {
    status = (
      <Callout
        tone="success"
        title={t("invoice.paidUpdating")}
        reference={reference}
        live
        data-testid="invoice-updating"
      />
    );
  } else if (view.kind === "paid") {
    status = (
      <Callout tone="success" title={t("invoice.paidTitle")} reference={reference} live data-testid="invoice-paid">
        {justPaid?.merchant
          ? t("invoice.paidBodyMerchant", { merchant: justPaid.merchant })
          : inv.paid_at
            ? t("invoice.paidBody", { date: formatDate(inv.paid_at) })
            : null}
      </Callout>
    );
  } else if (view.kind === "void") {
    status = (
      <Callout tone="neutral" title={t("invoice.voidTitle")} data-testid="invoice-void">
        {t("invoice.voidBody")}
      </Callout>
    );
  } else if (view.kind === "unknown") {
    status = (
      <Callout tone="neutral" title={t("invoice.unknownTitle")} data-testid="invoice-unknown">
        {t("invoice.unknownBody")}
      </Callout>
    );
  } else if (!view.payable) {
    status = (
      <Callout tone="warning" title={t("invoice.unpayableTitle")} data-testid="invoice-unpayable">
        {t("invoice.unpayableBody")}
      </Callout>
    );
  } else if (view.kind === "uncollectible") {
    status = (
      <Callout tone="warning" title={t("invoice.uncollectibleTitle")} data-testid="invoice-uncollectible">
        {t("invoice.uncollectibleBody")}
      </Callout>
    );
  } else if (view.overdue) {
    status = (
      <Callout tone="warning" title={t("invoice.overdueTitle")} data-testid="invoice-overdue">
        {t("invoice.overdueBody", { date: due })}
      </Callout>
    );
  }
  return status;
}

// ---- actions (the card on desktop) ------------------------------------------------------------------

function InvoiceActions({
  invoice: inv,
  view,
  secret,
  opening,
  error,
  justPaid,
  onPay,
  onAutoPay,
}: {
  invoice: Invoice;
  view: InvoiceStatusView;
  secret: string;
  opening: boolean;
  error: string | null;
  justPaid: JustPaid | null;
  onPay: () => void;
  onAutoPay: (view: "setup" | "manage") => void;
}) {
  const updating = justPaid !== null && view.kind !== "paid";
  const canPay = view.payable && !updating;
  return (
    <section className="ck-screen" aria-labelledby="ck-invoice-title" data-testid="invoice-actions">
      {error ? <Callout tone="danger" title={error} live data-testid="error" /> : null}
      {canPay ? (
        <div className="np-stack np-stack--sm">
          <Button
            fullWidth
            loading={opening}
            loadingText={t("invoice.opening")}
            onClick={onPay}
            data-testid="invoice-pay"
          >
            {inv.checkout_session ? t("invoice.continue") : t("invoice.pay")}
          </Button>
          <p className="np-checkout__note">{t("invoice.feesNote")}</p>
        </div>
      ) : null}
      <DownloadPdf invoice={inv} secret={secret} receipt={view.kind === "paid"} primary={!canPay} />
      <AutoPayEntry invoice={inv} onSetup={() => onAutoPay("setup")} onManage={() => onAutoPay("manage")} />
      {canPay ? (
        <div className="np-stack np-stack--sm">
          <p className="np-checkout__note">{t("invoice.noAccount")}</p>
          <p className="np-checkout__note">{t("invoice.merchantNote")}</p>
        </div>
      ) : (
        <p className="np-checkout__note">{t("invoice.footerNote")}</p>
      )}
    </section>
  );
}

function DownloadPdf({
  invoice: inv,
  secret,
  receipt,
  primary,
}: {
  invoice: Invoice;
  secret: string;
  receipt: boolean;
  primary: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const download = async () => {
    setBusy(true);
    setState("idle");
    try {
      const blob = await callBinary(getPublicInvoicePdf, { params: { id: inv.id }, invoiceSecret: secret });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = pdfFilename(inv.number);
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setState("done");
    } catch {
      setState("failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="np-stack np-stack--sm">
      <Button
        fullWidth
        variant={primary ? "primary" : "secondary"}
        loading={busy}
        loadingText={t("invoice.downloading")}
        onClick={() => void download()}
        data-testid="invoice-download"
      >
        {receipt ? t("invoice.downloadReceipt") : t("invoice.download")}
      </Button>
      {state === "failed" ? (
        <Callout tone="danger" title={t("invoice.downloadFailed")} live data-testid="download-error" />
      ) : null}
      <LiveRegion>{state === "done" ? t("invoice.downloaded") : ""}</LiveRegion>
    </div>
  );
}

// ---- payment: the unchanged checkout flow, in place ---------------------------------------------------

function InvoiceCheckout({
  invoice,
  session,
  onBack,
  onViewInvoice,
  onRestart,
}: {
  invoice: Invoice;
  session: Session;
  onBack: () => void;
  onViewInvoice: (paid: JustPaid) => void;
  onRestart: () => void;
}) {
  const c = useCheckout({ sessionId: session.id, secret: session.secret });
  const view = invoiceStatus(invoice, Date.now());
  const paid: JustPaid = {
    merchant: c.trusted?.attestation.merchant.name ?? null,
    reference: c.state.session?.payment_intent ?? null,
  };
  return (
    <CheckoutView
      c={c}
      mode="hosted"
      onCancel={onBack}
      summaryHead={<InvoiceDocument invoice={invoice} view={view} compact />}
      completeActions={
        <Button fullWidth onClick={() => onViewInvoice(paid)} data-testid="view-invoice">
          {t("invoice.viewInvoice")}
        </Button>
      }
      renderBlocked={(reason) =>
        reason === "session_expired" || reason === "session_canceled" ? (
          <StateScreen
            testId="invoice-session-expired"
            icon={<ClockIcon />}
            title={reason === "session_expired" ? t("invoice.sessionExpiredTitle") : t("invoice.sessionCanceledTitle")}
            body={reason === "session_expired" ? t("invoice.sessionExpiredBody") : t("invoice.sessionCanceledBody")}
            actions={
              <>
                <Button fullWidth onClick={onRestart} data-testid="invoice-restart">
                  {t("invoice.startAgain")}
                </Button>
                <Button fullWidth variant="secondary" onClick={onBack} data-testid="invoice-back">
                  {t("invoice.back")}
                </Button>
              </>
            }
          />
        ) : null
      }
    />
  );
}

/**
 * When the page switches between the invoice and the payment flow the focused control disappears: move
 * focus to the new view's title (as the checkout does on step changes), never on first paint.
 */
/** Auto-pay screens: the compact invoice in the desktop summary column (as during payment). */
function AutoPayFrame({ invoice, children }: { invoice: Invoice; children: ReactNode }) {
  const wide = useMediaQuery(WIDE_QUERY);
  return (
    <CheckoutFrame
      securedLabel={t("app.poweredBy")}
      summary={
        wide ? <InvoiceDocument invoice={invoice} view={invoiceStatus(invoice, Date.now())} compact /> : undefined
      }
      banner={
        invoice.livemode ? undefined : (
          <Callout tone="info" title={t("app.testmode")} reference={t("app.testmodeRef")} data-testid="test-banner" />
        )
      }
      links={webLinks}
      className="ck-frame ck-invoice"
      data-testid="invoice-page"
    >
      <div className="ck-flow">{children}</div>
    </CheckoutFrame>
  );
}

function useFocusTitle(kind: PageState["kind"]) {
  const last = useRef(kind);
  useEffect(() => {
    if (last.current === kind) return;
    const from = last.current;
    last.current = kind;
    if (from === "loading" && kind !== "paying") return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const h = document.querySelector<HTMLElement>(".ck-frame h1");
    if (h) {
      h.setAttribute("tabindex", "-1");
      h.focus({ preventScroll: true });
    }
  }, [kind]);
}
