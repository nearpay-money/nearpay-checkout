/**
 * "Pay with" (choose_asset): a network dropdown and a token dropdown (side by side from 640 px), the
 * quote box (Merchant receives, Network fee; "You send" on phones, where the order summary is collapsed —
 * on desktop the navy order side shows it) and Continue. The network list names chains only (one row per
 * chain, its logo); the token list shows a token's logo, symbol and — with a wallet connected — its
 * balance, nothing else unless the row can't be picked (the reason). When no option can be used at all,
 * one message replaces the dropdowns (`allUnavailableReason`). Both dropdowns search inside their own panel
 * and scroll inside it, so the screen stays about one viewport tall however many routes exist.
 *
 * With a wallet connected (live mode) the token list shows only the tokens that wallet holds on the
 * chosen network, with their balance, by value; tokens below this payment's indicative amount are
 * listed as "Not enough". "Show all tokens" lists every token (to pay from another wallet or an
 * exchange). Without a wallet (manual path, QR) or when balances can't be read, the full list shows.
 * Continue: the wallet path prepares the payment (attempt + sentinel verification → review), the
 * manual path opens "Send from another wallet".
 */
import { Button, Callout, KeyValueList, Skeleton } from "@nearpay-internal/ui";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { ConnectedWallet, Option } from "../../app/machine";
import type { WalletReads } from "../../app/useCheckout";
import { chainName } from "../../lib/chains/chains";
import { hasMessage, t } from "../../lib/i18n/t";
import { ScreenTitle, WalletLine } from "../../ui/blocks";
import { CryptoIcon } from "../../ui/CryptoIcon";
import { Picker, type PickerItem } from "../../ui/Picker";
import { shortAddress } from "../wallet-connect/wallets";
import { allUnavailableReason, defaultNetwork, INTENTS_NETWORK, networkKey, networksOf, optionKey } from "./options";
import { type BalanceRead, estimateText, formatBalance, rowSelectable, type TokenRow, tokenRows } from "./tokens";

/** Balance reads that take longer fall back to the full list. */
export const BALANCE_TIMEOUT_MS = 8000;
/** More networks than this get group headings (popular first). */
const GROUP_AFTER = 6;
const POPULAR = 4;

type Balance = { readonly state: "loading" } | { readonly state: "error" } | BalanceRead;

function unavailableText(o: Option): string {
  const key = `asset.unavailable.${o.reason ?? "route_unavailable"}`;
  return hasMessage(key) ? t(key) : t("asset.unavailable.route_unavailable");
}

/** The one message shown when no option can be used (keyed off the shared reason). */
export function allUnavailableText(reason: string): string {
  const key = `asset.allUnavailable.${reason}`;
  return hasMessage(key) ? t(key) : t("asset.allUnavailable.route_unavailable");
}

/** Second line of a token row: only why it can't be picked, or that its balance couldn't be read. */
function rowNote(r: TokenRow): string | undefined {
  if (!r.option.available) return unavailableText(r.option);
  if (r.short) return t("asset.notEnough");
  if (r.unavailable) return t("asset.balanceUnavailable");
  return undefined;
}

function tokenItem(r: TokenRow, network: string): PickerItem {
  const o = r.option;
  return {
    value: optionKey(o),
    label: o.symbol,
    icon: <CryptoIcon kind="token" id={o.symbol} />,
    trailing:
      r.balance !== null ? (
        <span className="ck-balance">
          <span className="np-sr-only">, {t("asset.balanceLabel")} </span>
          {formatBalance(r.balance, o.decimals)}
        </span>
      ) : undefined,
    description: rowNote(r),
    keywords: [network, o.chain],
    disabled: !rowSelectable(r),
    testId: `option-${o.method}-${o.origin_asset_id}`,
  };
}

export interface PayWithProps {
  options: readonly Option[] | null;
  wallet: ConnectedWallet | null;
  /** Option being prepared (Continue shows a spinner). */
  pendingKey: string | null;
  busy: boolean;
  onPick: (o: Option) => void;
  /** The human check has not produced a token yet for the pending option. */
  needsChallenge: boolean;
  /** Wallet balance reads (wallet path, live mode); null → full lists, no balances. */
  walletReads: WalletReads | null;
  /** Option to preselect (e.g. the same token after "Pay from another wallet or exchange"). */
  preferKey?: string | null;
  /** Formatted wallet balances (by option key) of the network just read, for the review's token card. */
  onBalances?: (balances: ReadonlyMap<string, string>) => void;
  /** The option currently chosen in the dropdowns (null: none), for the order side's "You send". */
  onChoice?: (o: Option | null) => void;
  /** "Merchant receives" in the quote box: the price. */
  merchantReceives: ReactNode;
  /** Desktop split layout: the order side shows "You send", so the quote box leaves it out. */
  wide: boolean;
}

export function PayWith({
  options,
  wallet,
  pendingKey,
  busy,
  onPick,
  needsChallenge,
  walletReads,
  preferKey = null,
  onBalances,
  onChoice,
  merchantReceives,
  wide,
}: PayWithProps) {
  const all = useMemo(() => options ?? [], [options]);
  const networks = useMemo(() => networksOf(all), [all]);
  const prefer = preferKey ? (all.find((o) => optionKey(o) === preferKey && o.available) ?? null) : null;
  const [network, setNetwork] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [readRun, setReadRun] = useState(0);
  const cache = useRef(new Map<string, BalanceRead>());

  const net = network !== null && networks.some((n) => n.key === network) ? network : defaultNetwork(all, prefer);
  const netOptions = useMemo(() => all.filter((o) => networkKey(o) === net), [all, net]);
  const netLabel = net === INTENTS_NETWORK ? t("network.intents") : (networks.find((n) => n.key === net)?.label ?? "");

  // ---- wallet balances of the chosen network (cached per network) --------------------------------------
  useEffect(() => {
    void readRun; // re-read after a chain switch
    if (!walletReads || !net || netOptions.length === 0) {
      setBalance(null);
      return;
    }
    const hit = cache.current.get(net);
    if (hit) {
      setBalance(hit);
      return;
    }
    let cancelled = false;
    setBalance({ state: "loading" });
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), BALANCE_TIMEOUT_MS),
    );
    Promise.race([walletReads.balances(netOptions), timeout])
      .then((r) => {
        if (cancelled) return;
        if (r.state === "ok") cache.current.set(net, r);
        setBalance(r);
      })
      .catch(() => !cancelled && setBalance({ state: "error" }));
    return () => {
      cancelled = true;
    };
  }, [walletReads, net, netOptions, readRun]);

  const held = balance?.state === "ok" ? balance.balances : null;
  useEffect(() => {
    if (!held || !onBalances) return;
    const out = new Map<string, string>();
    for (const o of netOptions) {
      const b = held.get(optionKey(o));
      if (typeof b === "string") out.set(optionKey(o), formatBalance(b, o.decimals));
    }
    onBalances(out);
  }, [held, netOptions, onBalances]);
  const rows = useMemo(() => tokenRows(netOptions, held, showAll), [netOptions, held, showAll]);
  const selectable = rows.filter(rowSelectable);
  const tokenKey =
    picked !== null && selectable.some((r) => optionKey(r.option) === picked)
      ? picked
      : prefer && selectable.some((r) => optionKey(r.option) === preferKey)
        ? preferKey
        : selectable[0]
          ? optionKey(selectable[0].option)
          : null;
  const selectedRow = rows.find((r) => optionKey(r.option) === tokenKey) ?? null;
  const selected = selectedRow?.option ?? null;
  const loadingBalances = balance?.state === "loading";

  // ---- items --------------------------------------------------------------------------------------------
  const networkItems = useMemo<PickerItem[]>(() => {
    const grouped = networks.length > GROUP_AFTER;
    let usable = 0;
    return networks.map((n) => {
      const opts = all.filter((o) => networkKey(o) === n.key);
      const available = opts.some((o) => o.available);
      const symbols = [...new Set(opts.map((o) => o.symbol))];
      if (available) usable += 1;
      return {
        value: n.key,
        label: n.key === INTENTS_NETWORK ? t("network.intents") : n.label,
        icon: <CryptoIcon kind="chain" id={n.key} label={n.label} />,
        // Chain names only; a row that can't be picked says why.
        description: available ? undefined : unavailableText(opts[0] as Option),
        keywords: [...symbols, n.key],
        disabled: !available,
        group: grouped
          ? !available
            ? t("network.unavailable")
            : usable <= POPULAR
              ? t("network.popular")
              : t("network.more")
          : undefined,
        testId: `network-${n.key}`,
      };
    });
  }, [networks, all]);
  const tokenItems = useMemo(() => rows.map((r) => tokenItem(r, netLabel)), [rows, netLabel]);

  const chainOf = balance?.state === "wrong_chain" ? balance.chain : null;
  const estimate = selected ? estimateText(selected) : null;
  const paused = allUnavailableReason(all);

  useEffect(() => {
    onChoice?.(selected);
  }, [selected, onChoice]);

  const quoteRows = [
    ...(!wide && selected
      ? [
          {
            label: t("summary.youSend"),
            value: estimate ? (
              <span data-testid="selected-estimate">{t("asset.youSendAbout", { amount: estimate })}</span>
            ) : (
              <span className="np-text-secondary">{t("asset.estimateUnknown")}</span>
            ),
          },
        ]
      : []),
    { label: t("fees.merchant"), value: <span data-testid="quote-merchant">{merchantReceives}</span> },
    {
      label: t("fees.networkShort"),
      value: (
        <span className="np-text-secondary" data-testid="quote-network-fee">
          {selected?.method === "intents_transfer"
            ? t("fees.networkNone")
            : wallet
              ? t("fees.networkWallet")
              : t("fees.networkSender")}
        </span>
      ),
    },
  ];

  return (
    <section className="ck-screen ck-paywith" data-testid="asset-picker" aria-labelledby="ck-paywith-title">
      <ScreenTitle id="ck-paywith-title" title={t("asset.title")} />
      {options === null ? (
        <div className="np-pickers" aria-busy="true" data-testid="options-loading">
          <p className="np-sr-only" role="status">
            {t("asset.loading")}
          </p>
          <Skeleton shape="block" />
          <Skeleton shape="block" />
        </div>
      ) : paused ? (
        <Callout tone="warning" title={allUnavailableText(paused)} live data-testid="all-unavailable" />
      ) : (
        <div className="np-pickers">
          <Picker
            label={t("asset.network")}
            items={networkItems}
            value={net}
            onChange={(v) => {
              setNetwork(v);
              setPicked(null);
              setShowAll(false);
            }}
            placeholder={t("asset.networkPlaceholder")}
            searchLabel={t("network.search")}
            empty={t("network.none")}
            countLabel={(n) => (n === 1 ? t("network.countOne") : t("network.count", { count: n }))}
            closeLabel={t("asset.closeList")}
            disabled={busy}
            testId="network-picker"
          />
          <Picker
            label={t("asset.token")}
            items={tokenItems}
            value={tokenKey}
            onChange={setPicked}
            triggerBalance={
              selectedRow?.balance != null && selected
                ? formatBalance(selectedRow.balance, selected.decimals)
                : undefined
            }
            balanceLabel={t("asset.balanceLabel")}
            triggerDescription={selectedRow?.unavailable ? t("asset.balanceUnavailable") : undefined}
            highlight={selected !== null}
            placeholder={t("asset.tokenPlaceholder")}
            searchLabel={t("asset.tokenSearch")}
            empty={
              held && !showAll && rows.length === 0 ? t("asset.noHeld", { network: netLabel }) : t("asset.tokenNone")
            }
            loading={loadingBalances}
            loadingLabel={t("asset.balancesLoading")}
            footer={
              held ? (
                <button
                  type="button"
                  className="np-link-button np-picker__toggle"
                  aria-pressed={showAll}
                  onClick={() => setShowAll((v) => !v)}
                  data-testid="show-all-tokens"
                >
                  {showAll ? t("asset.showHeld") : t("asset.showAll")}
                </button>
              ) : undefined
            }
            countLabel={(n) => (n === 1 ? t("asset.countOne") : t("asset.count", { count: n }))}
            closeLabel={t("asset.closeList")}
            disabled={busy}
            testId="token-picker"
          />
        </div>
      )}
      {wallet ? (
        <WalletLine testId="connected-wallet">
          {t("review.walletLine", { wallet: wallet.label, address: shortAddress(wallet.address) })}
        </WalletLine>
      ) : null}
      {loadingBalances ? (
        <p className="np-checkout__note" role="status" data-testid="balances-loading">
          {t("asset.balancesLoading")}
        </p>
      ) : balance?.state === "error" ? (
        <p className="np-checkout__note" role="status" data-testid="balances-error">
          {t("asset.balancesError")}
        </p>
      ) : chainOf && walletReads ? (
        <p className="np-checkout__note ck-inline-action" data-testid="balances-wrong-chain">
          <span>{t("asset.wrongChain", { network: chainName(chainOf) })}</span>
          <button
            type="button"
            className="np-link-button"
            onClick={() => {
              void walletReads
                .switchChain(chainOf)
                .then(() => setReadRun((n) => n + 1))
                .catch(() => undefined);
            }}
            data-testid="switch-chain"
          >
            {t("asset.switchChain", { network: chainName(chainOf) })}
          </button>
        </p>
      ) : held && !showAll && rows.length === 0 ? (
        <p className="np-checkout__note ck-inline-action" role="status" data-testid="no-held-tokens">
          <span>{t("asset.noHeld", { network: netLabel })}</span>
          <button type="button" className="np-link-button" onClick={() => setShowAll(true)}>
            {t("asset.showAll")}
          </button>
        </p>
      ) : null}
      {paused ? null : (
        <div className="ck-quote" data-testid="quote-box">
          <KeyValueList className="ck-quote__rows" items={quoteRows} />
        </div>
      )}
      {paused ? null : (
        <div className="np-stack np-stack--sm">
          <Button
            fullWidth
            size="lg"
            disabled={!selected || busy || loadingBalances}
            loading={selected !== null && pendingKey === optionKey(selected) && (busy || needsChallenge)}
            loadingText={t("verify.button")}
            onClick={() => selected && onPick(selected)}
            data-testid="asset-continue"
          >
            {t("asset.continue")}
          </Button>
          {needsChallenge ? (
            <p className="np-checkout__note" role="status">
              {t("asset.checking")}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
