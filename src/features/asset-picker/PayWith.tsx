/**
 * "Pay with" (choose_asset): search, "All networks" filter → "Choose a network", the options available
 * for this payment, and the "No matching payment options" state. Tapping an option continues: the wallet
 * path prepares the payment (attempt + sentinel verification → review), the manual path opens
 * "Send from another wallet".
 */
import {
  Button,
  ChevronDownIcon,
  Combobox,
  LiveRegion,
  Money,
  SearchInput,
  Skeleton,
  StatusBadge,
} from "@nearpay-internal/ui";
import { useMemo, useState } from "react";
import type { ConnectedWallet, Option } from "../../app/machine";
import { hasMessage, t } from "../../lib/i18n/t";
import { OptionButton, ScreenTitle } from "../../ui/blocks";
import { shortAddress } from "../wallet-connect/wallets";
import { filterOptions, networksOf, optionKey, optionTitle } from "./options";

function OptionDescription({ o }: { o: Option }) {
  if (!o.available) {
    const key = `asset.unavailable.${o.reason ?? "route_unavailable"}`;
    return <>{hasMessage(key) ? t(key) : t("asset.unavailable.route_unavailable")}</>;
  }
  const prefix = o.method === "intents_transfer" ? `${t("asset.intents")} · ` : "";
  if (!o.estimated_amount_in) return <>{`${prefix}${t("asset.estimateUnknown")}`}</>;
  return (
    <>
      {prefix}≈ <Money amount={o.estimated_amount_in} decimals={o.decimals} symbol={o.symbol} /> · includes fees
    </>
  );
}

export function PayWith({
  options,
  wallet,
  pendingKey,
  busy,
  onPick,
  needsChallenge,
}: {
  options: readonly Option[] | null;
  wallet: ConnectedWallet | null;
  /** Option being prepared (spinner on its row). */
  pendingKey: string | null;
  busy: boolean;
  onPick: (o: Option) => void;
  /** The human check has not produced a token yet for the pending option. */
  needsChallenge: boolean;
}) {
  const [query, setQuery] = useState("");
  const [network, setNetwork] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const networks = useMemo(() => networksOf(options ?? []), [options]);
  const visible = useMemo(() => filterOptions(options ?? [], query, network), [options, query, network]);
  const networkLabel =
    network === null ? t("asset.allNetworks") : (networks.find((n) => n.key === network)?.label ?? network);

  if (picking) {
    return (
      <ChooseNetwork
        networks={networks}
        value={network}
        onApply={(n) => {
          setNetwork(n);
          setPicking(false);
        }}
      />
    );
  }

  return (
    <section className="ck-screen" data-testid="asset-picker" aria-labelledby="ck-paywith-title">
      {wallet ? (
        <p className="ck-connected" data-testid="connected-wallet">
          <StatusBadge tone="success">{t("wallet.connected")}</StatusBadge>
          <span className="np-checkout__note">
            {t("wallet.connectedAs", { wallet: wallet.label, address: shortAddress(wallet.address) })}
          </span>
        </p>
      ) : null}
      <ScreenTitle id="ck-paywith-title" title={t("asset.title")} />
      <div className="np-stack">
        <SearchInput
          aria-label={t("asset.search")}
          placeholder={t("asset.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="asset-search"
        />
        <button
          type="button"
          className="ck-filter"
          onClick={() => setPicking(true)}
          aria-label={t("asset.networkFilter", { network: networkLabel })}
          data-testid="network-filter"
        >
          <span>{networkLabel}</span>
          <ChevronDownIcon size={20} />
        </button>
      </div>
      {options === null ? (
        <div className="np-stack" aria-busy="true">
          <p className="np-sr-only" role="status">
            {t("asset.loading")}
          </p>
          <Skeleton shape="block" />
          <Skeleton shape="block" />
          <Skeleton shape="block" />
        </div>
      ) : visible.length > 0 ? (
        <div className="np-stack">
          <p className="np-option-group__label" id="ck-available">
            {t("asset.available")}
          </p>
          <ul className="ck-list" aria-labelledby="ck-available">
            {visible.map((o) => {
              const key = optionKey(o);
              return (
                <li key={key}>
                  <OptionButton
                    avatar={o.symbol}
                    title={optionTitle(o)}
                    description={<OptionDescription o={o} />}
                    disabled={!o.available || (busy && pendingKey !== key)}
                    selected={pendingKey === key}
                    pending={pendingKey === key && busy}
                    onClick={() => onPick(o)}
                    testId={`option-${o.method}-${o.origin_asset_id}`}
                  />
                </li>
              );
            })}
          </ul>
          {needsChallenge ? (
            <p className="np-checkout__note" role="status">
              {t("asset.checking")}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="np-stack" data-testid="no-match">
          <h2 className="ck-subtitle">{t("asset.noMatch")}</h2>
          <p className="np-checkout__lede">{t("asset.noMatchBody")}</p>
          <Button
            fullWidth
            variant="secondary"
            onClick={() => {
              setQuery("");
              setNetwork(null);
            }}
          >
            {t("asset.clearFilters")}
          </Button>
        </div>
      )}
      <LiveRegion>
        {options && (query || network)
          ? visible.length === 1
            ? t("asset.countOne")
            : t("asset.count", { count: visible.length })
          : ""}
      </LiveRegion>
    </section>
  );
}

function ChooseNetwork({
  networks,
  value,
  onApply,
}: {
  networks: readonly { key: string; label: string }[];
  value: string | null;
  onApply: (network: string | null) => void;
}) {
  const [draft, setDraft] = useState<string>(value ?? "all");
  const items = [
    { value: "all", label: t("asset.allNetworks") },
    ...networks.map((n) => ({ value: n.key, label: n.label })),
  ];
  return (
    <section className="ck-screen" data-testid="choose-network" aria-labelledby="ck-network-title">
      <ScreenTitle id="ck-network-title" title={t("network.title")} />
      <Combobox
        label={t("network.search")}
        placeholder={t("network.search")}
        options={items}
        value={draft}
        onChange={setDraft}
        variant="rows"
        empty={t("network.none")}
      />
      <Button fullWidth onClick={() => onApply(draft === "all" ? null : draft)} data-testid="network-apply">
        {t("network.apply")}
      </Button>
    </section>
  );
}
