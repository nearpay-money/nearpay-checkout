/** Hosted checkout `/c/:id#<client_secret>` (§1, §5.9: success → redirect to `success_url?session_id=`). */
import { useEffect, useState } from "react";
import { CheckoutView } from "../../app/CheckoutView";
import { safeHttpUrl, successRedirect } from "../../app/route";
import { useCheckout } from "../../app/useCheckout";
import { t } from "../../lib/i18n/t";
import { Button } from "../../ui/primitives";

export const REDIRECT_DELAY_MS = 2500;

export function HostedCheckout({ sessionId, secret }: { sessionId: string; secret: string }) {
  const c = useCheckout({ sessionId, secret });
  const session = c.state.session;
  const succeeded = c.state.phase === "succeeded";
  const target = succeeded && session ? successRedirect(session.success_url, sessionId) : null;
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    if (!target) return;
    setRedirecting(true);
    const id = setTimeout(() => window.location.assign(target), REDIRECT_DELAY_MS);
    return () => clearTimeout(id);
  }, [target]);

  const cancel = safeHttpUrl(session?.cancel_url ?? null);
  const footer = (
    <>
      {target ? (
        <>
          {redirecting ? <span className="np-help">{t("succeeded.redirect")}</span> : null}
          <a className="np-btn np-btn-primary" href={target} data-testid="continue-merchant">
            {t("succeeded.continue")}
          </a>
        </>
      ) : null}
      {cancel && !succeeded && c.state.phase !== "processing" ? (
        <a className="np-link" href={cancel} data-testid="cancel">
          {t("app.cancel")}
        </a>
      ) : null}
    </>
  );
  return <CheckoutView c={c} footer={footer} />;
}

export function InvalidLink() {
  return (
    <main className="np-card">
      <section className="np-section" data-testid="blocked">
        <h2 className="np-h2">{t("blocked.title")}</h2>
        <p data-testid="blocked-invalid_link">{t("blocked.invalid_link")}</p>
      </section>
    </main>
  );
}

export function NotAvailable({ what }: { what: string }) {
  return (
    <main className="np-card">
      <section className="np-section" data-testid="not-available">
        <h2 className="np-h2">{t("blocked.title")}</h2>
        <p>{what}</p>
        <Button kind="link" onClick={() => window.history.back()}>
          {t("app.back")}
        </Button>
      </section>
    </main>
  );
}
