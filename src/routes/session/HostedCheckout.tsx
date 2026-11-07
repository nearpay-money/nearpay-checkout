/** Hosted checkout `/c/:id#<client_secret>` (§1, §5.9: success → redirect to `success_url?session_id=`). */
import { CheckoutFrame } from "@nearpay-internal/ui";
import { useEffect, useState } from "react";
import { CheckoutView } from "../../app/CheckoutView";
import { safeHttpUrl, successRedirect } from "../../app/route";
import { BlockedScreen } from "../../app/StatusScreens";
import { useCheckout } from "../../app/useCheckout";
import { webLinks } from "../../config";

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

  return (
    <CheckoutView
      c={c}
      mode="hosted"
      returnTo={target}
      redirecting={redirecting}
      cancelUrl={safeHttpUrl(session?.cancel_url ?? null)}
    />
  );
}

/** A link without a valid client secret, an unknown path, or a page not built yet (invoices, Stage 3). */
export function InvalidLink({ reason = "invalid_link" }: { reason?: "invalid_link" | "not_available" }) {
  return (
    <CheckoutFrame links={webLinks} className="ck-frame">
      <div className="ck-flow">
        <BlockedScreen reason={reason} />
      </div>
    </CheckoutFrame>
  );
}
