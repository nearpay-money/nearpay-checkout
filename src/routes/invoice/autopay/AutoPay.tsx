/**
 * Hosted invoice auto-pay (Stage 4; lld/checkout-and-js.md §4.4, lld/billing.md §5/§14 d5/d8,
 * lld/contracts-vault.md §3.1 funding UX rule). Non-custodial: the payer funds a mandate in the vault
 * smart contract from their own NEAR account; the merchant can collect at most the authorised amount per
 * period; the payer can top up, cancel (remaining balance back) or withdraw at any time. NearPay never
 * holds the balance and holds no key that could move it (INV-1).
 *
 * - Setup: `createPublicInvoiceMandateFunding` (no side effects) → clear terms (from the parsed `msg`,
 *   checked against the instruction fields and the transactions, `model.checkFunding`) → the payer's
 *   NEAR wallet signs `storage_deposit` (when returned) + `ft_transfer_call` on the token with
 *   `receiver_id` = the vault → re-read the invoice until billing has recorded the mandate.
 * - Manage: `getPublicInvoiceMandate` → status, balance, next collection → top up / cancel / withdraw,
 *   signed by the mandate's payer account only.
 * - Test mode never broadcasts (INV-8, §5.8): terms are shown, signing is replaced by a note.
 */

import { createPublicInvoiceMandateFunding, getPublicInvoice, getPublicInvoiceMandate } from "@nearpay/spec";
import {
  Button,
  Callout,
  Checkbox,
  type KeyValueItem,
  KeyValueList,
  LiveRegion,
  Modal,
  Money,
  OptionCard,
  RadioCardGroup,
  Skeleton,
  StatusBadge,
  WalletIcon,
  WarningIcon,
} from "@nearpay-internal/ui";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { call, isApiError } from "../../../lib/api/client";
import { autopayEn } from "../../../lib/i18n/messages.autopay.en";
import { errorText, registerMessages, t } from "../../../lib/i18n/t";
import { ScreenTitle, StateScreen } from "../../../ui/blocks";
import { connectNearWallet, type NearWallet, nearAvailable } from "../../../wallets/near/connector";
import { depositTxHash } from "../../../wallets/near/tx";
import { formatDate, type Invoice } from "../model";
import {
  checkFunding,
  DEFAULT_PERIODS,
  exitTransaction,
  type Funding,
  type FundingTerms,
  feeFact,
  MANDATE_POLL_MAX,
  MANDATE_POLL_MS,
  type Mandate,
  mandateView,
  nearMoney,
  PERIOD_CHOICES,
  periodLabel,
  startAtMs,
  type TokenMeta,
  tokenMeta,
  tokenMoney,
  topUpTransaction,
} from "./model";

registerMessages(autopayEn);

// ---- shared bits -----------------------------------------------------------------------------------

function TokenAmount({ amount, meta, token }: { amount: string; meta: TokenMeta | null; token: string }) {
  const m = tokenMoney(amount, meta);
  return m ? <Money {...m} /> : <span>{t("autopay.rawAmount", { amount, token })}</span>;
}

function every(secs: number): string {
  const p = periodLabel(secs);
  return p ? t(p.key, { n: String(p.n) }) : t("autopay.every.secs", { n: String(secs) });
}

function unitPlural(secs: number, n: number): string {
  const p = periodLabel(secs);
  if (p?.n !== 1) return t("autopay.periods", { n: String(n) });
  const unit = p.key.replace("autopay.every.", "");
  return t(`autopay.count.${unit}${n === 1 ? "" : "s"}` as Parameters<typeof t>[0], { n: String(n) });
}

const rejected = (e: unknown) => /reject|denied|declined|cancel|closed/i.test(e instanceof Error ? e.message : "");

function walletError(e: unknown): string {
  if (rejected(e)) return t("autopay.notApproved");
  if (isApiError(e)) return errorText(e.code);
  const msg = e instanceof Error ? e.message.slice(0, 160) : "";
  return msg ? t("error.wallet_failed", { message: msg }) : t("error.generic");
}

/** Connected NEAR account line with a "Change" action. */
function SigningAs({ wallet, onChange }: { wallet: NearWallet; onChange: () => void }) {
  return (
    <div className="ck-autopay-signer" data-testid="autopay-signer">
      <WalletIcon />
      <span className="ck-autopay-signer__text">
        {t("autopay.signingAs", { account: wallet.accountId, wallet: wallet.label })}
      </span>
      <Button variant="ghost" size="sm" onClick={onChange}>
        {t("autopay.change")}
      </Button>
    </div>
  );
}

function useNearWallet() {
  const [wallet, setWallet] = useState<NearWallet | null>(null);
  const [connecting, setConnecting] = useState(false);
  const connect = useCallback(async (): Promise<NearWallet> => {
    setConnecting(true);
    try {
      const w = await connectNearWallet();
      setWallet(w);
      return w;
    } finally {
      setConnecting(false);
    }
  }, []);
  return { wallet, connecting, connect, reset: () => setWallet(null), available: nearAvailable() };
}

// ---- entry on the invoice ---------------------------------------------------------------------------

/** What the invoice card shows for `PublicInvoice.auto_debit` (null when the invoice has none). */
export function AutoPayEntry({
  invoice: inv,
  onSetup,
  onManage,
}: {
  invoice: Invoice;
  onSetup: () => void;
  onManage: () => void;
}) {
  const ad = inv.auto_debit;
  if (!ad) return null;
  if (ad.collecting) {
    return (
      <div className="np-stack np-stack--sm" data-testid="autopay-entry">
        <Callout tone="success" title={t("autopay.collectingTitle")} data-testid="autopay-collecting">
          {t("autopay.collectingBody")}
        </Callout>
        {ad.mandate ? (
          <Button fullWidth variant="secondary" onClick={onManage} data-testid="autopay-manage">
            {t("autopay.manage")}
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="ck-autopay-entry np-stack np-stack--sm" data-testid="autopay-entry">
      {ad.available ? (
        <>
          <h2 className="ck-autopay-entry__title">{t("autopay.entryTitle")}</h2>
          <p className="np-checkout__note">{t("autopay.entryBody")}</p>
          <Button fullWidth variant="secondary" onClick={onSetup} data-testid="autopay-setup">
            {t("autopay.setup")}
          </Button>
        </>
      ) : null}
      {ad.mandate ? (
        <Button
          fullWidth
          variant={ad.available ? "ghost" : "secondary"}
          onClick={onManage}
          data-testid="autopay-manage"
        >
          {t("autopay.manage")}
        </Button>
      ) : null}
    </div>
  );
}

// ---- setup -------------------------------------------------------------------------------------------

type Setup =
  | { readonly step: "loading" }
  | { readonly step: "failed"; readonly message: string; readonly notPayable: boolean }
  | { readonly step: "terms"; readonly funding: Funding; readonly terms: FundingTerms; readonly notice: string | null }
  | { readonly step: "approving"; readonly count: number }
  | { readonly step: "waiting"; readonly txHash: string | null; readonly slow: boolean };

const sameTerms = (a: FundingTerms, b: FundingTerms) =>
  a.merchantReceiver === b.merchantReceiver &&
  a.receiverKind === b.receiverKind &&
  a.amountPerPeriod === b.amountPerPeriod &&
  a.periodSecs === b.periodSecs &&
  a.startAt === b.startAt &&
  a.feeBps === b.feeBps;

export function AutoPaySetup({
  invoice: inv,
  secret,
  onBack,
  onActive,
}: {
  invoice: Invoice;
  secret: string;
  onBack: () => void;
  /** Billing has recorded the mandate (the page switches to the management view). */
  onActive: () => void;
}) {
  const [st, setSt] = useState<Setup>({ step: "loading" });
  const [periods, setPeriods] = useState<number>(DEFAULT_PERIODS);
  const [own, setOwn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const near = useNearWallet();
  const live = inv.livemode;

  const fetchFunding = useCallback(
    (payer: string | null, n: number) =>
      call(createPublicInvoiceMandateFunding, {
        params: { id: inv.id },
        body: payer ? { payer, periods: n } : { periods: n },
        invoiceSecret: secret,
      }),
    [inv.id, secret],
  );

  /** Preview of the terms (no payer yet): deterministic, no side effects. */
  const preview = useCallback(async () => {
    setSt({ step: "loading" });
    setError(null);
    try {
      let f: Funding;
      try {
        f = await fetchFunding(null, DEFAULT_PERIODS);
      } catch (e) {
        // Three periods can exceed the vault's per-mandate cap: the terms are the same for one period.
        if (!isApiError(e, "vault_cap_exceeded")) throw e;
        f = await fetchFunding(null, 1);
        setPeriods(1);
      }
      const c = checkFunding(f, null);
      if (!c.ok) throw new Error(t(`autopay.problem.${c.problem}`));
      setSt({ step: "terms", funding: f, terms: c.terms, notice: null });
    } catch (e) {
      setSt({
        step: "failed",
        message: isApiError(e) ? errorText(e.code) : e instanceof Error && e.message ? e.message : t("error.generic"),
        notPayable: isApiError(e, "invoice_not_payable") || isApiError(e, "state_conflict"),
      });
    }
  }, [fetchFunding]);
  useEffect(() => {
    void preview();
  }, [preview]);

  // After the funding transaction: poll the invoice until billing reports the mandate.
  const waiting = st.step === "waiting";
  useEffect(() => {
    if (!waiting) return;
    let n = 0;
    let stop = false;
    const timer = setInterval(() => {
      n++;
      void call(getPublicInvoice, { params: { id: inv.id }, invoiceSecret: secret })
        .then((i) => {
          if (stop) return;
          if (i.auto_debit?.mandate) {
            clearInterval(timer);
            onActive();
          } else if (n >= MANDATE_POLL_MAX) {
            clearInterval(timer);
            setSt((cur) => (cur.step === "waiting" ? { ...cur, slow: true } : cur));
          }
        })
        .catch(() => undefined);
    }, MANDATE_POLL_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [waiting, inv.id, secret, onActive]);

  const approve = async () => {
    if (st.step !== "terms" || !live) return;
    setBusy(true);
    setError(null);
    try {
      const w = near.wallet ?? (await near.connect());
      // Fresh instructions for this payer (storage check) and the chosen periods.
      const f = await fetchFunding(w.accountId, periods);
      const c = checkFunding(f, w.accountId);
      if (!c.ok) {
        setError(t(`autopay.problem.${c.problem}`));
        return;
      }
      if (!sameTerms(c.terms, st.terms)) {
        // The per-period terms moved since the preview: show them again before anything is signed.
        setSt({ step: "terms", funding: f, terms: c.terms, notice: t("autopay.termsChanged") });
        return;
      }
      setSt({ step: "approving", count: c.transactions.length });
      let txHash: string | null = null;
      try {
        const out = await w.signAndSendTransactions(c.transactions);
        try {
          txHash = depositTxHash(out);
        } catch {
          txHash = null;
        }
      } catch (e) {
        setSt({ step: "terms", funding: f, terms: c.terms, notice: null });
        setError(walletError(e));
        return;
      }
      setSt({ step: "waiting", txHash, slow: false });
    } catch (e) {
      setError(walletError(e));
    } finally {
      setBusy(false);
    }
  };

  if (st.step === "loading") return <SetupSkeleton />;

  if (st.step === "failed") {
    return (
      <StateScreen
        testId="autopay-failed"
        icon={<WarningIcon />}
        title={t("autopay.unavailableTitle")}
        body={st.message}
        actions={
          <>
            {st.notPayable ? null : (
              <Button fullWidth onClick={() => void preview()} data-testid="autopay-retry">
                {t("invoice.retry")}
              </Button>
            )}
            <Button fullWidth variant="secondary" onClick={onBack} data-testid="autopay-back">
              {t("invoice.back")}
            </Button>
          </>
        }
      />
    );
  }

  if (st.step === "approving") {
    return (
      <StateScreen
        testId="autopay-approving"
        icon={<WalletIcon />}
        title={t("autopay.approveTitle")}
        body={st.count === 2 ? t("autopay.approveBody2") : t("autopay.approveBody1")}
        badge={t("autopay.approveBadge")}
        badgeTone="info"
      />
    );
  }

  if (st.step === "waiting") {
    return (
      <StateScreen
        testId="autopay-waiting"
        icon={<WalletIcon />}
        title={st.slow ? t("autopay.slowTitle") : t("autopay.waitingTitle")}
        body={st.slow ? t("autopay.slowBody") : t("autopay.waitingBody")}
        badge={st.slow ? undefined : t("autopay.waitingBadge")}
        badgeTone="info"
        callout={st.txHash ? t("autopay.txSent") : undefined}
        reference={st.txHash ?? undefined}
        actions={
          st.slow ? (
            <Button fullWidth variant="secondary" onClick={onBack} data-testid="autopay-back">
              {t("invoice.back")}
            </Button>
          ) : undefined
        }
      />
    );
  }

  const { funding: f, terms } = st;
  const meta = tokenMeta(f.token, inv, f.token_asset);
  const choiceAmount = (n: number) => (BigInt(terms.amountPerPeriod) * BigInt(n)).toString();
  const start = startAtMs(terms.startAt);
  const storage = BigInt(f.storage.deposit) > 0n;
  const items: KeyValueItem[] = [
    {
      label: t("autopay.perPeriod", { every: every(terms.periodSecs) }),
      value: (
        <span data-testid="autopay-per-period">
          <TokenAmount amount={terms.amountPerPeriod} meta={meta} token={f.token} />
        </span>
      ),
    },
    {
      label: t("autopay.firstCollection"),
      value: (
        <span data-testid="autopay-first">
          {start === null ? t("autopay.firstNow") : formatDate(new Date(start).toISOString())}
        </span>
      ),
    },
    {
      label: t("autopay.paidTo"),
      value: (
        <span className="ck-autopay-mono" data-testid="autopay-receiver">
          {terms.merchantReceiver}
        </span>
      ),
    },
    {
      label: t("autopay.heldIn"),
      value: (
        <span className="ck-autopay-mono" data-testid="autopay-vault">
          {f.vault_contract}
        </span>
      ),
    },
    ...(terms.maxPeriods !== null
      ? [{ label: t("autopay.maxPeriods"), value: unitPlural(terms.periodSecs, terms.maxPeriods) }]
      : [{ label: t("autopay.ends"), value: t("autopay.endsNever") }]),
  ];
  const totals: KeyValueItem[] = [
    {
      label: t("autopay.fundNow", { periods: unitPlural(terms.periodSecs, periods) }),
      value: (
        <span data-testid="autopay-fund-amount">
          <TokenAmount amount={choiceAmount(periods)} meta={meta} token={f.token} />
        </span>
      ),
      total: !storage,
    },
    ...(storage
      ? [
          {
            label: t("autopay.storage"),
            value: (
              <span data-testid="autopay-storage">
                {near.wallet ? "" : t("autopay.upTo")}
                <Money {...nearMoney(f.storage.deposit)} />
              </span>
            ),
          },
        ]
      : []),
  ];
  const canSign = live && own && !busy;
  const fee = feeFact(terms.feeBps);
  return (
    <section className="ck-screen" aria-labelledby="ck-autopay-title" data-testid="autopay-terms">
      <ScreenTitle id="ck-autopay-title" title={t("autopay.setupTitle")} lede={t("autopay.setupLede")} />
      {st.notice ? <Callout tone="warning" title={st.notice} live data-testid="autopay-terms-changed" /> : null}
      <KeyValueList items={items} />
      <RadioCardGroup
        label={t("autopay.periodsLabel")}
        value={String(periods)}
        onChange={(v) => setPeriods(Number(v))}
        name="autopay-periods"
      >
        {PERIOD_CHOICES.map((n) => (
          <OptionCard
            key={n}
            value={String(n)}
            title={t("autopay.fundFor", { periods: unitPlural(terms.periodSecs, n) })}
            description={<TokenAmount amount={choiceAmount(n)} meta={meta} token={f.token} />}
            indicator="none"
          />
        ))}
      </RadioCardGroup>
      <KeyValueList items={totals} />
      <ul className="ck-autopay-facts" data-testid="autopay-facts">
        <li>{t("autopay.factLimit", { every: every(terms.periodSecs) })}</li>
        <li>{t("autopay.factCancel")}</li>
        <li>{t("autopay.factCustody")}</li>
        <li data-testid="autopay-fee">{t(fee.key, fee.vars)}</li>
      </ul>
      <Callout tone="warning" title={t("autopay.noticeTitle")} data-testid="autopay-payer-notice">
        {f.payer_notice}
      </Callout>
      {live ? (
        <>
          {near.wallet ? <SigningAs wallet={near.wallet} onChange={near.reset} /> : null}
          <Checkbox
            variant="tile"
            label={t("autopay.ownAccount")}
            checked={own}
            onChange={(e) => setOwn(e.currentTarget.checked)}
            data-testid="autopay-own-account"
          />
          {error ? <Callout tone="danger" title={error} live data-testid="error" /> : null}
          {!near.available ? (
            <Callout tone="warning" title={t("autopay.noNear")} data-testid="autopay-no-near" />
          ) : null}
          <div className="np-stack np-stack--sm">
            <Button
              fullWidth
              disabled={!canSign || !near.available}
              loading={busy}
              loadingText={near.connecting ? t("autopay.connecting") : t("autopay.preparing")}
              onClick={() => void approve()}
              data-testid="autopay-approve"
            >
              {near.wallet ? t("autopay.approve") : t("autopay.connectAndApprove")}
            </Button>
            <Button fullWidth variant="secondary" onClick={onBack} data-testid="autopay-back">
              {t("invoice.back")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <Callout tone="info" title={t("autopay.testTitle")} data-testid="autopay-test-note">
            {t("autopay.testBody")}
          </Callout>
          <Button fullWidth variant="secondary" onClick={onBack} data-testid="autopay-back">
            {t("invoice.back")}
          </Button>
        </>
      )}
    </section>
  );
}

function SetupSkeleton() {
  return (
    <section className="ck-screen" aria-busy="true" data-testid="autopay-loading">
      <LiveRegion>{t("autopay.loading")}</LiveRegion>
      <Skeleton shape="title" width="75" />
      <Skeleton shape="block" />
      <Skeleton shape="block" />
      <Skeleton shape="text" width="75" />
    </section>
  );
}

// ---- manage ------------------------------------------------------------------------------------------

type Manage =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly code: string }
  | { readonly kind: "none" }
  | { readonly kind: "ready"; readonly mandate: Mandate };

type Action = "top_up" | "cancel" | "withdraw";

export function AutoPayManage({
  invoice: inv,
  secret,
  onBack,
}: {
  invoice: Invoice;
  secret: string;
  onBack: () => void;
}) {
  const [st, setSt] = useState<Manage>({ kind: "loading" });
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ action: Action; hash: string | null } | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [topUpPeriods, setTopUpPeriods] = useState<number>(DEFAULT_PERIODS);
  const [topUpOpen, setTopUpOpen] = useState(false);
  const near = useNearWallet();
  const seq = useRef(0);

  const load = useCallback(
    async (quiet = false) => {
      const n = ++seq.current;
      if (!quiet) setSt({ kind: "loading" });
      try {
        const m = await call(getPublicInvoiceMandate, { params: { id: inv.id }, invoiceSecret: secret });
        if (n === seq.current) setSt({ kind: "ready", mandate: m });
        return m;
      } catch (e) {
        if (n !== seq.current) return null;
        if (isApiError(e) && e.status === 404) setSt({ kind: "none" });
        else if (!quiet) setSt({ kind: "failed", code: isApiError(e) ? e.code : "generic" });
        return null;
      }
    },
    [inv.id, secret],
  );
  useEffect(() => {
    void load();
  }, [load]);

  // After a payer transaction: re-read until the mandate changes (rails → billing lag).
  const before = useRef<string | null>(null);
  useEffect(() => {
    if (!sent) return;
    let n = 0;
    const timer = setInterval(() => {
      n++;
      void load(true).then((m) => {
        const key = m ? `${m.status}|${m.balance}|${m.funded_periods}` : null;
        if ((key && key !== before.current) || n >= MANDATE_POLL_MAX) {
          clearInterval(timer);
          setSent(null);
        }
      });
    }, MANDATE_POLL_MS);
    return () => clearInterval(timer);
  }, [sent, load]);

  if (st.kind === "loading") return <SetupSkeleton />;
  if (st.kind === "failed" || st.kind === "none") {
    return (
      <StateScreen
        testId="autopay-manage-failed"
        icon={<WarningIcon />}
        title={st.kind === "none" ? t("autopay.noneTitle") : t("autopay.loadFailed")}
        body={st.kind === "none" ? t("autopay.noneBody") : errorText(st.code)}
        actions={
          <>
            {st.kind === "failed" ? (
              <Button fullWidth onClick={() => void load()} data-testid="autopay-retry">
                {t("invoice.retry")}
              </Button>
            ) : null}
            <Button fullWidth variant="secondary" onClick={onBack} data-testid="autopay-back">
              {t("invoice.back")}
            </Button>
          </>
        }
      />
    );
  }

  const m = st.mandate;
  const view = mandateView(m);
  const meta = tokenMeta(m.token, inv, m.token_asset);
  const cancelTx = exitTransaction(m, "cancel");
  const withdrawTx = exitTransaction(m, "withdraw");
  const live = m.livemode;

  const sign = async (action: Action) => {
    setError(null);
    setBusy(action);
    try {
      const tx =
        action === "top_up"
          ? topUpTransaction(m, (BigInt(m.amount_per_period) * BigInt(topUpPeriods)).toString())
          : action === "cancel"
            ? cancelTx
            : withdrawTx;
      if (!tx) throw new Error(t("autopay.problem.transactions"));
      const w = near.wallet ?? (await near.connect());
      // The vault accepts these only from the mandate's payer (top-ups from anyone else are refunded).
      if (w.accountId !== m.payer) {
        setError(t("autopay.wrongAccount", { payer: m.payer, account: w.accountId }));
        return;
      }
      before.current = `${m.status}|${m.balance}|${m.funded_periods}`;
      const out = await w.signAndSendTransactions([tx]);
      let hash: string | null = null;
      try {
        hash = depositTxHash(out);
      } catch {
        hash = null;
      }
      setConfirmCancel(false);
      setTopUpOpen(false);
      setSent({ action, hash });
    } catch (e) {
      setError(walletError(e));
    } finally {
      setBusy(null);
    }
  };

  const next = m.next_collect_at;
  const items: KeyValueItem[] = [
    {
      label: t("autopay.perPeriod", { every: every(m.period_secs) }),
      value: <TokenAmount amount={m.amount_per_period} meta={meta} token={m.token} />,
    },
    ...(next && (view.kind === "active" || view.kind === "insufficient") && m.collecting
      ? [
          {
            label: t("autopay.nextCollection"),
            value: <span data-testid="autopay-next">{formatDate(new Date(next * 1000).toISOString())}</span>,
          },
        ]
      : []),
    { label: t("autopay.collected"), value: unitPlural(m.period_secs, m.collected_periods) },
    {
      label: t("autopay.payer"),
      value: (
        <span className="ck-autopay-mono" data-testid="autopay-payer">
          {m.payer}
        </span>
      ),
    },
    { label: t("autopay.heldIn"), value: <span className="ck-autopay-mono">{m.vault_contract}</span> },
  ];

  let callout: ReactNode = null;
  if (view.orphaned) {
    callout = (
      <Callout tone="warning" title={t("autopay.orphanedTitle")} data-testid="autopay-orphaned">
        {t("autopay.orphanedBody")}
      </Callout>
    );
  } else if (view.kind === "insufficient") {
    callout = (
      <Callout tone="warning" title={t("autopay.lowTitle")} data-testid="autopay-low">
        {t("autopay.lowBody")}
      </Callout>
    );
  } else if ((view.kind === "exhausted" || view.kind === "canceled") && withdrawTx) {
    callout = (
      <Callout tone="info" title={t("autopay.withdrawTitle")} data-testid="autopay-withdrawable">
        {t("autopay.withdrawBody")}
      </Callout>
    );
  } else if (view.kind === "canceled") {
    callout = <Callout tone="neutral" title={t("autopay.canceledTitle")} data-testid="autopay-canceled" />;
  } else if (view.kind === "active") {
    callout = (
      <Callout tone="success" title={t("autopay.activeTitle")} data-testid="autopay-active">
        {t("autopay.activeBody")}
      </Callout>
    );
  }

  const topUpAmount = (BigInt(m.amount_per_period) * BigInt(topUpPeriods)).toString();
  return (
    <section className="ck-screen" aria-labelledby="ck-autopay-manage-title" data-testid="autopay-manage-view">
      <div className="ck-autopay-head">
        <h1 className="np-checkout__title" id="ck-autopay-manage-title">
          {t("autopay.manageTitle")}
        </h1>
        <StatusBadge tone={view.badge.tone} data-testid="autopay-status">
          {t(view.badge.label)}
        </StatusBadge>
      </div>
      <div>
        <p className="np-checkout__amount" data-testid="autopay-balance">
          <TokenAmount amount={m.balance} meta={meta} token={m.token} />
        </p>
        <p className="np-checkout__lede">
          {t("autopay.balanceLede", { periods: unitPlural(m.period_secs, m.funded_periods) })}
        </p>
      </div>
      {callout}
      <KeyValueList items={items} />
      {sent ? (
        <Callout
          tone="info"
          title={t("autopay.sentTitle")}
          reference={sent.hash ?? undefined}
          live
          data-testid="autopay-sent"
        >
          {t("autopay.sentBody")}
        </Callout>
      ) : null}
      {error ? <Callout tone="danger" title={error} live data-testid="error" /> : null}
      {live ? (
        <div className="np-stack">
          {near.wallet ? <SigningAs wallet={near.wallet} onChange={near.reset} /> : null}
          {view.canTopUp && !topUpOpen ? (
            <Button
              fullWidth
              onClick={() => setTopUpOpen(true)}
              disabled={busy !== null}
              data-testid="autopay-topup-open"
            >
              {t("autopay.topUpButton")}
            </Button>
          ) : null}
          {view.canTopUp && topUpOpen ? (
            <div className="np-stack np-stack--sm" data-testid="autopay-topup">
              <RadioCardGroup
                label={t("autopay.topUpLabel")}
                value={String(topUpPeriods)}
                onChange={(v) => setTopUpPeriods(Number(v))}
                name="autopay-topup"
              >
                {PERIOD_CHOICES.map((n) => (
                  <OptionCard
                    key={n}
                    value={String(n)}
                    title={t("autopay.fundFor", { periods: unitPlural(m.period_secs, n) })}
                    description={
                      <TokenAmount
                        amount={(BigInt(m.amount_per_period) * BigInt(n)).toString()}
                        meta={meta}
                        token={m.token}
                      />
                    }
                    indicator="none"
                  />
                ))}
              </RadioCardGroup>
              <p className="np-checkout__note">{t("autopay.topUpNote")}</p>
              <Button
                fullWidth
                loading={busy === "top_up"}
                loadingText={t("autopay.confirmInWallet")}
                disabled={busy !== null || !near.available}
                onClick={() => void sign("top_up")}
                data-testid="autopay-topup-approve"
              >
                {t("autopay.topUpButton")} <TokenAmount amount={topUpAmount} meta={meta} token={m.token} />
              </Button>
              <Button fullWidth variant="ghost" onClick={() => setTopUpOpen(false)} disabled={busy !== null}>
                {t("autopay.topUpClose")}
              </Button>
            </div>
          ) : null}
          {withdrawTx ? (
            <Button
              fullWidth
              loading={busy === "withdraw"}
              loadingText={t("autopay.confirmInWallet")}
              disabled={busy !== null || !near.available}
              onClick={() => void sign("withdraw")}
              data-testid="autopay-withdraw"
            >
              {t("autopay.withdraw")}
            </Button>
          ) : null}
          {cancelTx ? (
            <Button
              fullWidth
              variant={view.orphaned ? "primary" : "secondary"}
              disabled={busy !== null || !near.available}
              onClick={() => setConfirmCancel(true)}
              data-testid="autopay-cancel"
            >
              {t("autopay.cancel")}
            </Button>
          ) : null}
          {!near.available ? <Callout tone="warning" title={t("autopay.noNear")} /> : null}
          <Button fullWidth variant="ghost" onClick={onBack} data-testid="autopay-back">
            {t("invoice.back")}
          </Button>
        </div>
      ) : (
        <>
          <Callout tone="info" title={t("autopay.testTitle")} data-testid="autopay-test-note">
            {t("autopay.testManageBody")}
          </Callout>
          <Button fullWidth variant="secondary" onClick={onBack} data-testid="autopay-back">
            {t("invoice.back")}
          </Button>
        </>
      )}
      <Modal
        open={confirmCancel}
        onClose={() => busy === null && setConfirmCancel(false)}
        title={t("autopay.cancelTitle")}
        description={t("autopay.cancelBody", { payer: m.payer })}
        size="sm"
        data-testid="autopay-cancel-dialog"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmCancel(false)} disabled={busy !== null}>
              {t("autopay.keep")}
            </Button>
            <Button
              variant="danger"
              loading={busy === "cancel"}
              loadingText={t("autopay.confirmInWallet")}
              onClick={() => void sign("cancel")}
              data-testid="autopay-cancel-confirm"
            >
              {t("autopay.cancelConfirm")}
            </Button>
          </>
        }
      >
        <KeyValueList
          items={[
            { label: t("autopay.returned"), value: <TokenAmount amount={m.balance} meta={meta} token={m.token} /> },
          ]}
        />
        {error ? <Callout tone="danger" title={error} live /> : null}
      </Modal>
    </section>
  );
}
