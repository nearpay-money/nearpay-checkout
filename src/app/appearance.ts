/**
 * Merchant appearance (§5.3: theme `light|dark|auto`, accent `#rgb/#rrggbb`, radius 0–24 px) through the
 * ui package's `applyAppearance`: custom properties set with the CSSOM (allowed by the CSP, never an
 * inline `style=""` attribute), accents adjusted until every pair meets WCAG AA. `auto` follows
 * `prefers-color-scheme`, re-deriving the accent when the system theme changes.
 */
import { applyAppearance } from "@nearpay-internal/ui";
import type { Appearance } from "../routes/embed/protocol";

export function applyCheckoutAppearance(root: HTMLElement, a: Appearance, win: Window = window): () => void {
  const mq = typeof win.matchMedia === "function" ? win.matchMedia("(prefers-color-scheme: dark)") : null;
  const apply = () =>
    applyAppearance(
      root,
      {
        theme: a.theme,
        ...(a.accent !== null ? { accent: a.accent } : {}),
        ...(a.radius !== null ? { radius: a.radius } : {}),
      },
      mq?.matches ?? false,
    );
  apply();
  if (a.theme !== "auto" || !mq) return () => undefined;
  mq.addEventListener("change", apply);
  return () => mq.removeEventListener("change", apply);
}
