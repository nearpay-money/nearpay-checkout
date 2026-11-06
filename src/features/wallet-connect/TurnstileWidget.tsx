import { useEffect, useRef } from "react";
import { config } from "../../config";
import { loadTurnstile } from "./turnstile";

/** Renders the Turnstile challenge and reports a fresh token (null when it expires or fails). */
export function TurnstileWidget({ onToken, resetKey }: { onToken: (token: string | null) => void; resetKey: string }) {
  const el = useRef<HTMLDivElement>(null);
  const cb = useRef(onToken);
  cb.current = onToken;
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey forces a fresh widget (one token per attempt)
  useEffect(() => {
    let id: string | null = null;
    let cancelled = false;
    cb.current(null);
    loadTurnstile()
      .then((ts) => {
        if (cancelled || !el.current) return;
        id = ts.render(el.current, {
          sitekey: config.turnstileSitekey,
          callback: (token: string) => cb.current(token),
          "expired-callback": () => cb.current(null),
          "error-callback": () => cb.current(null),
          appearance: "interaction-only",
        });
      })
      .catch(() => cb.current(null));
    return () => {
      cancelled = true;
      if (id !== null) window.turnstile?.remove(id);
    };
  }, [resetKey]);
  return <div className="np-turnstile" ref={el} data-testid="turnstile" />;
}
