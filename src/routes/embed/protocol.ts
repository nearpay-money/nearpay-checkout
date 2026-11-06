/**
 * Checkout side of the `nearpay-js` postMessage protocol v1 (lld/checkout-and-js.md §6; the protocol is
 * owned and versioned in `nearpay-js/protocol/v1.md`). Messages are `{type, v: 1, …payload}`.
 *
 *   parent → iframe  np:init      {appearance: {theme, accent, radius}, locale}
 *   iframe → parent  np:ready     {}
 *   iframe → parent  np:resize    {height}
 *   iframe → parent  np:complete  {session_id, payment_intent_id}
 *   iframe → parent  np:error     {code, message}
 *   iframe → parent  np:close     {}
 *
 * §5.3: `np:init` is accepted only from the parent window and only when `event.origin` is one of the
 * session's `allowed_origins` (and `location.ancestorOrigins[0]` agrees when the browser exposes it);
 * every iframe → parent message is posted to that verified origin only, never "*".
 */
export const PROTOCOL_VERSION = 1 as const;

export interface Appearance {
  readonly theme: "light" | "dark" | "auto";
  readonly accent: string | null;
  readonly radius: number | null;
}

export interface InitMessage {
  readonly appearance: Appearance;
  readonly locale: string | null;
}

export const DEFAULT_APPEARANCE: Appearance = { theme: "auto", accent: null, radius: null };

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function sanitizeAppearance(a: unknown): Appearance {
  if (typeof a !== "object" || a === null) return DEFAULT_APPEARANCE;
  const { theme, accent, radius } = a as Record<string, unknown>;
  return {
    theme: theme === "light" || theme === "dark" ? theme : "auto",
    accent: typeof accent === "string" && HEX_COLOR.test(accent) ? accent : null,
    radius:
      typeof radius === "number" && Number.isFinite(radius) && radius >= 0 && radius <= 24 ? Math.round(radius) : null,
  };
}

/** Parses an inbound message; only `np:init` v1 is accepted. */
export function parseInit(data: unknown): InitMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.type !== "np:init" || m.v !== PROTOCOL_VERSION) return null;
  const locale = typeof m.locale === "string" && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(m.locale) ? m.locale : null;
  return { appearance: sanitizeAppearance(m.appearance), locale };
}

/** Canonical origin (`https://shop.example`), or null when not an http(s) origin. */
export function normalizeOrigin(o: string): string | null {
  try {
    const u = new URL(o);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function originAllowed(origin: string, allowed: readonly string[]): boolean {
  const o = normalizeOrigin(origin);
  if (!o) return false;
  return allowed.some((a) => normalizeOrigin(a) === o);
}

/** §5.3 check for one inbound message; `ancestor` = `location.ancestorOrigins?.[0]`. */
export function initAccepted(
  ev: { readonly origin: string; readonly fromParent: boolean },
  allowed: readonly string[],
  ancestor: string | null | undefined,
): boolean {
  if (!ev.fromParent) return false;
  if (!originAllowed(ev.origin, allowed)) return false;
  if (ancestor && normalizeOrigin(ancestor) !== normalizeOrigin(ev.origin)) return false;
  return true;
}

export type OutboundMessage =
  | { readonly type: "np:ready" }
  | { readonly type: "np:resize"; readonly height: number }
  | { readonly type: "np:complete"; readonly session_id: string; readonly payment_intent_id: string | null }
  | { readonly type: "np:error"; readonly code: string; readonly message: string }
  | { readonly type: "np:close" };

export function envelope(m: OutboundMessage): Record<string, unknown> {
  return { ...m, v: PROTOCOL_VERSION };
}
