/** "Pay with wallet": EVM wallets announced through EIP-6963, and NEAR wallets through NEAR Connect. */
import { useEffect, useState } from "react";
import { t } from "../../lib/i18n/t";
import { Button, Notice, Spinner } from "../../ui/primitives";
import {
  type DiscoveredWallet,
  discoverInjectedWallets,
  requestAccount,
  safeIcon,
  WalletRejected,
} from "../../wallets/evm/provider";
import { connectNearWallet, NearUnavailable, nearAvailable } from "../../wallets/near/connector";
import type { WalletHandle } from "./wallets";

export function WalletConnect({ onConnected }: { onConnected: (w: WalletHandle) => void }) {
  const [evm, setEvm] = useState<DiscoveredWallet[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const near = nearAvailable();

  useEffect(() => {
    let cancelled = false;
    void discoverInjectedWallets(window).then((list) => !cancelled && setEvm(list));
    return () => {
      cancelled = true;
    };
  }, []);

  const fail = (e: unknown) => {
    if (e instanceof WalletRejected) setError(t("wallet.rejected"));
    else if (e instanceof NearUnavailable) setError(t("wallet.nearUnavailable"));
    else setError(t("wallet.failed", { message: e instanceof Error ? e.message.slice(0, 160) : String(e) }));
  };

  const connectEvm = async (w: DiscoveredWallet) => {
    setError(null);
    setPending(w.info.name);
    try {
      const address = await requestAccount(w.provider);
      onConnected({ family: "evm", address, label: w.info.name, provider: w.provider });
    } catch (e) {
      fail(e);
    } finally {
      setPending(null);
    }
  };

  const connectNear = async () => {
    setError(null);
    setPending("NEAR");
    try {
      const wallet = await connectNearWallet();
      onConnected({ family: "near", address: wallet.accountId, label: wallet.label, wallet });
    } catch (e) {
      fail(e);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="np-wallets" data-testid="wallet-connect">
      <h2 className="np-h2">{t("wallet.title")}</h2>
      {pending ? <Spinner label={t("wallet.connecting", { wallet: pending })} /> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      <h3 className="np-h3">{t("wallet.evm")}</h3>
      {evm === null ? (
        <Spinner label={t("wallet.searching")} />
      ) : evm.length === 0 ? (
        <p className="np-help" data-testid="no-evm-wallet">
          {t("wallet.noneFound")}
        </p>
      ) : (
        <ul className="np-list">
          {evm.map((w) => {
            const icon = safeIcon(w.info.icon);
            return (
              <li key={w.info.uuid}>
                <button
                  type="button"
                  className="np-wallet"
                  onClick={() => void connectEvm(w)}
                  disabled={pending !== null}
                  data-testid={`evm-wallet-${w.info.rdns}`}
                >
                  {icon ? (
                    <img src={icon} alt="" width={24} height={24} />
                  ) : (
                    <span className="np-chain-icon" aria-hidden="true" />
                  )}
                  <span>{w.info.name}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <h3 className="np-h3">{t("wallet.near")}</h3>
      {near ? (
        <Button kind="secondary" onClick={() => void connectNear()} disabled={pending !== null} testId="near-connect">
          {t("wallet.nearConnect")}
        </Button>
      ) : (
        <p className="np-help" data-testid="near-unavailable">
          {t("wallet.nearUnavailable")}
        </p>
      )}
    </div>
  );
}
