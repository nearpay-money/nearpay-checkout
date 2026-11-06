/**
 * Embedded checkout `/embed/:id#<client_secret>` (§5.3, §6): loads the session, verifies the parent's
 * `np:init` against `allowed_origins` (+ ancestorOrigins), then runs the same flow as hosted mode and
 * reports `np:ready`, `np:resize`, `np:complete`, `np:error` and `np:close` to the verified parent.
 */
import { useEffect, useRef, useState } from "react";
import { CheckoutView } from "../../app/CheckoutView";
import { useCheckout } from "../../app/useCheckout";
import { t } from "../../lib/i18n/t";
import { Button } from "../../ui/primitives";
import { applyAppearance, type Bridge } from "./bridge";

export function EmbeddedCheckout({ sessionId, secret, bridge }: { sessionId: string; secret: string; bridge: Bridge }) {
  const c = useCheckout({ sessionId, secret });
  const [verified, setVerified] = useState<boolean>(false);
  const started = useRef(false);
  const { session, phase, intent, blockReason } = c.state;

  useEffect(() => {
    if (!session || started.current) return;
    started.current = true;
    if (!bridge.framed) {
      c.actions.block("not_framed");
      return;
    }
    void bridge.verify(session.allowed_origins).then((r) => {
      if (r === "rejected") {
        c.actions.block("origin_mismatch");
        return;
      }
      applyAppearance(document.documentElement, r.init.appearance);
      setVerified(true);
      bridge.post({ type: "np:ready" });
    });
  }, [session, bridge, c.actions]);

  // np:resize — the iframe follows its content height.
  useEffect(() => {
    if (!verified) return;
    let last = 0;
    const report = () => {
      const h = Math.ceil(document.documentElement.scrollHeight);
      if (h !== last) {
        last = h;
        bridge.post({ type: "np:resize", height: h });
      }
    };
    const ro = new ResizeObserver(report);
    ro.observe(document.body);
    report();
    return () => ro.disconnect();
  }, [verified, bridge]);

  const completed = useRef(false);
  useEffect(() => {
    if (!verified || phase !== "succeeded" || completed.current) return;
    completed.current = true;
    bridge.post({ type: "np:complete", session_id: sessionId, payment_intent_id: intent?.id || null });
  }, [verified, phase, intent, sessionId, bridge]);

  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (!verified || phase !== "blocked" || !blockReason || reported.current === blockReason) return;
    reported.current = blockReason;
    bridge.post({ type: "np:error", code: blockReason, message: t(`blocked.${blockReason}`) });
  }, [verified, phase, blockReason, bridge]);

  // Nothing but a spinner until the parent is verified; a rejected parent sees only the blocked notice.
  if (!verified && phase !== "blocked") return <CheckoutView c={{ ...c, state: { ...c.state, phase: "loading" } }} />;
  const footer =
    verified && phase !== "succeeded" && phase !== "processing" ? (
      <Button kind="link" onClick={() => bridge.post({ type: "np:close" })} testId="close">
        {t("app.close")}
      </Button>
    ) : null;
  return <CheckoutView c={c} footer={footer} />;
}
