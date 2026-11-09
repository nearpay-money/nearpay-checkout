/**
 * "Pay your way" (choose_path) and "Connect a wallet" (connect_wallet): EVM wallets announced through
 * EIP-6963, Solana wallets through the Wallet Standard (Stage 4, §11) and NEAR wallets through NEAR
 * Connect (the Solana and NEAR modules are lazy-loaded, §7 budget).
 */
import { Avatar, Button, Callout, LiveRegion } from "@nearpay-internal/ui";
import { useEffect, useState } from "react";
import { t } from "../../lib/i18n/t";
import { OptionButton, ScreenTitle } from "../../ui/blocks";
import {
  type DiscoveredWallet,
  discoverInjectedWallets,
  requestAccount,
  safeIcon,
  WalletRejected,
} from "../../wallets/evm/provider";
import { connectNearWallet, NearUnavailable, nearAvailable } from "../../wallets/near/connector";
import type { DiscoveredSolanaWallet } from "../../wallets/solana/standard";
import type { WalletHandle } from "./wallets";

export function StartScreen({
  embedded,
  onWallet,
  onManual,
}: {
  embedded: boolean;
  onWallet: () => void;
  onManual: () => void;
}) {
  return (
    <section className="ck-screen" data-testid="choose-path" aria-labelledby="ck-start-title">
      <ScreenTitle
        id="ck-start-title"
        title={embedded ? t("start.titleEmbed") : t("start.title")}
        lede={embedded ? undefined : t("start.lede")}
      />
      <div className="np-stack">
        <Button fullWidth onClick={onWallet} data-testid="path-wallet">
          {t("start.wallet")}
        </Button>
        <Button fullWidth variant="secondary" onClick={onManual} data-testid="path-manual">
          {embedded ? t("start.manualEmbed") : t("start.manual")}
        </Button>
      </div>
      {embedded ? null : <Callout tone="info" title={t("start.noAccount")} reference={t("start.noAccountBody")} />}
    </section>
  );
}

function WalletAvatar({ icon, name }: { icon: string | null; name: string }) {
  // Only `data:` icons are shown (CSP img-src 'self' data:); others fall back to the initial.
  return icon ? (
    <img className="ck-wallet-icon" src={icon} alt="" width={32} height={32} />
  ) : (
    <Avatar initial={name} size="sm" />
  );
}

export function WalletConnect({
  onConnected,
  onCancel,
  onManual,
}: {
  onConnected: (w: WalletHandle) => void;
  onCancel: () => void;
  onManual: () => void;
}) {
  const [evm, setEvm] = useState<DiscoveredWallet[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sol, setSol] = useState<DiscoveredSolanaWallet[] | null>(null);
  const near = nearAvailable();

  useEffect(() => {
    let cancelled = false;
    let stopSol: (() => void) | null = null;
    void discoverInjectedWallets(window).then((list) => !cancelled && setEvm(list));
    void import("../../wallets/solana/standard")
      .then((m) => {
        if (cancelled) return;
        stopSol = m.discoverSolanaWallets((list) => !cancelled && setSol(list));
      })
      .catch(() => !cancelled && setSol([]));
    return () => {
      cancelled = true;
      stopSol?.();
    };
  }, []);

  const fail = (e: unknown) => {
    if (e instanceof WalletRejected) setError(t("wallet.rejected"));
    else if (e instanceof NearUnavailable) setError(t("wallet.nearUnavailable"));
    else setError(t("wallet.failed", { message: e instanceof Error ? e.message.slice(0, 160) : String(e) }));
  };

  const connectEvm = async (w: DiscoveredWallet) => {
    setError(null);
    setPending(w.info.uuid);
    try {
      const address = await requestAccount(w.provider);
      onConnected({ family: "evm", address, label: w.info.name, provider: w.provider });
    } catch (e) {
      fail(e);
    } finally {
      setPending(null);
    }
  };

  const connectSolana = async (d: DiscoveredSolanaWallet) => {
    setError(null);
    setPending(`sol:${d.id}`);
    try {
      const m = await import("../../wallets/solana/standard");
      const wallet = await m.connectSolanaWallet(d);
      onConnected({ family: "solana", address: wallet.address, label: wallet.label, wallet });
    } catch (e) {
      fail(e);
    } finally {
      setPending(null);
    }
  };

  const connectNear = async () => {
    setError(null);
    setPending("near");
    try {
      const wallet = await connectNearWallet();
      onConnected({ family: "near", address: wallet.accountId, label: wallet.label, wallet });
    } catch (e) {
      fail(e);
    } finally {
      setPending(null);
    }
  };

  const pendingName =
    pending === "near"
      ? t("wallet.nearTitle")
      : (evm?.find((w) => w.info.uuid === pending)?.info.name ??
        sol?.find((w) => `sol:${w.id}` === pending)?.name ??
        null);

  return (
    <section className="ck-screen" data-testid="wallet-connect" aria-labelledby="ck-wallet-title">
      <ScreenTitle id="ck-wallet-title" title={t("wallet.title")} lede={t("wallet.lede")} />
      {error ? <Callout tone="danger" title={error} live data-testid="wallet-error" /> : null}
      <LiveRegion>{pendingName ? t("wallet.connecting", { wallet: pendingName }) : ""}</LiveRegion>
      <ul className="ck-list" aria-label={t("wallet.title")}>
        {evm === null ? (
          <li className="np-checkout__note">{t("wallet.searching")}</li>
        ) : (
          evm.map((w) => (
            <li key={w.info.uuid}>
              <OptionButton
                avatar={<WalletAvatar icon={safeIcon(w.info.icon)} name={w.info.name} />}
                title={t("wallet.walletSuffix", { name: w.info.name })}
                description={
                  pending === w.info.uuid ? t("wallet.connecting", { wallet: w.info.name }) : t("wallet.browserWallet")
                }
                pending={pending === w.info.uuid}
                disabled={pending !== null && pending !== w.info.uuid}
                onClick={() => void connectEvm(w)}
                testId={`evm-wallet-${w.info.rdns}`}
              />
            </li>
          ))
        )}
        {(sol ?? []).map((w) => (
          <li key={w.id}>
            <OptionButton
              avatar={<WalletAvatar icon={w.icon} name={w.name} />}
              title={t("wallet.walletSuffix", { name: w.name })}
              description={
                pending === `sol:${w.id}` ? t("wallet.connecting", { wallet: w.name }) : t("wallet.solanaHint")
              }
              pending={pending === `sol:${w.id}`}
              disabled={pending !== null && pending !== `sol:${w.id}`}
              onClick={() => void connectSolana(w)}
              testId={`sol-wallet-${w.id}`}
            />
          </li>
        ))}
        {near ? (
          <li>
            <OptionButton
              avatar="N"
              title={t("wallet.nearTitle")}
              description={pending === "near" ? t("wallet.connecting", { wallet: "NEAR" }) : t("wallet.nearHint")}
              pending={pending === "near"}
              disabled={pending !== null && pending !== "near"}
              onClick={() => void connectNear()}
              testId="near-connect"
            />
          </li>
        ) : null}
      </ul>
      {evm !== null && evm.length === 0 && sol !== null && sol.length > 0 ? null : evm !== null && evm.length === 0 ? (
        <p className="np-checkout__note" data-testid="no-evm-wallet">
          {t("wallet.noneFound")}
        </p>
      ) : null}
      {near ? null : (
        <p className="np-checkout__note" data-testid="near-unavailable">
          {t("wallet.nearUnavailable")}
        </p>
      )}
      <div className="np-stack">
        <Button fullWidth variant="secondary" onClick={onCancel} data-testid="back">
          {t("wallet.cancel")}
        </Button>
        <button type="button" className="np-link-button ck-center" onClick={onManual} data-testid="use-manual">
          {t("wallet.useManual")}
        </button>
      </div>
    </section>
  );
}
