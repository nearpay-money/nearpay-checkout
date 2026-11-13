/**
 * Hosted checkout `/c/:id#<client_secret>` (§1, §5.9: success → redirect to `success_url?session_id=`).
 * A payment link without a merchant redirect has the checkout's own `/l/<plink>/complete` as its
 * `success_url`: there is nowhere to return to, so "Payment complete" is the final screen.
 */
import { CheckIcon, CheckoutFrame } from "@nearpay-internal/ui";
import { type ReactNode, useEffect, useState } from "react";
import { CheckoutView } from "../../app/CheckoutView";
import { siteOf } from "../../app/OrderSummary";
import { isOwnConfirmation, safeHttpUrl, successRedirect } from "../../app/route";
import { BlockedScreen } from "../../app/StatusScreens";
import { useCheckout } from "../../app/useCheckout";
import { webLinks } from "../../config";
import { t } from "../../lib/i18n/t";
import { StateScreen } from "../../ui/blocks";

export const REDIRECT_DELAY_MS = 2500;

export function HostedCheckout({ sessionId, secret }: { sessionId: string; secret: string }) {
  const c = useCheckout({ sessionId, secret });
  const session = c.state.session;
  const succeeded = c.state.phase === "succeeded";
  const own = !!session && isOwnConfirmation(session.success_url, window.location.origin);
  const target = succeeded && session && !own ? successRedirect(session.success_url, sessionId) : null;
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    if (!target) return;
    setRedirecting(true);
    const id = setTimeout(() => window.location.assign(target), REDIRECT_DELAY_MS);
    return () => clearTimeout(id);
  }, [target]);

  return (
    <CheckoutView
      c={c}
      mode="hosted"
      returnTo={target}
      redirecting={redirecting}
      completeActions={own ? <p className="np-checkout__note">{t("complete.close")}</p> : undefined}
      cancelUrl={safeHttpUrl(session?.cancel_url ?? null)}
      site={own ? null : siteOf(safeHttpUrl(session?.success_url ?? null))}
    />
  );
}

/** A page outside any session: the checkout frame with one status screen. */
function Page({ children }: { children: ReactNode }) {
  return (
    <CheckoutFrame links={webLinks} securedLabel={t("app.poweredBy")} className="ck-frame">
      <div className="ck-flow">{children}</div>
    </CheckoutFrame>
  );
}

/** A link without a valid client secret or an unknown path. */
export function InvalidLink() {
  return (
    <Page>
      <BlockedScreen reason="invalid_link" />
    </Page>
  );
}

/**
 * `/l/<plink>/complete`, reached by sessions opened before the checkout stopped redirecting to it, and
 * by reloads and bookmarks. Anyone can open this URL and it carries no client secret, so the page
 * cannot know whether a payment was made: it says so, and shows no "Paid" state, amount or merchant.
 */
export function LinkComplete() {
  return (
    <Page>
      <StateScreen
        testId="link-complete"
        icon={<CheckIcon />}
        iconTone="neutral"
        title={t("link.doneTitle")}
        body={t("link.doneBody")}
      />
    </Page>
  );
}
