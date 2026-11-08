/** Routes of the static SPA (§1): `/c/:id` hosted, `/embed/:id` iframe, `/l/:id` links, `/i/:id` invoices. */
import { ClientSecretHeaders, idPattern } from "@nearpay/spec";

export type Route =
  | { readonly kind: "hosted" | "embed"; readonly sessionId: string; readonly secret: string | null }
  | { readonly kind: "payment_link"; readonly id: string }
  /**
   * Hosted invoice `/i/<in_…>#<invoice secret>` (Stage 3). The (lazy-loaded) invoice page checks the
   * secret against the spec's `InvoiceSecret` (`invoiceLink`); `invoice` is null for a malformed id.
   */
  | { readonly kind: "invoice"; readonly invoice: { readonly id: string; readonly secret: string } | null }
  | { readonly kind: "not_found" };

const CS_RE = idPattern("cs");
const PLINK_RE = idPattern("plink");
const IN_RE = idPattern("in");
const secretSchema = ClientSecretHeaders.shape["x-nearpay-client-secret"];

export function parseRoute(pathname: string, hash: string): Route {
  const m = /^\/(c|embed|l|i)\/([^/]+)\/?$/.exec(pathname);
  if (!m) return { kind: "not_found" };
  const [, kind, id] = m as unknown as [string, string, string];
  if (kind === "l") return PLINK_RE.test(id) ? { kind: "payment_link", id } : { kind: "not_found" };
  const secret = hash.startsWith("#") ? hash.slice(1) : hash;
  if (kind === "i") return { kind: "invoice", invoice: IN_RE.test(id) ? { id, secret } : null };
  const valid = CS_RE.test(id) && secretSchema.safeParse(secret).success && secret.startsWith(`${id}_secret_`);
  return { kind: kind === "c" ? "hosted" : "embed", sessionId: id, secret: valid ? secret : null };
}

/** Success redirect (§5.9): `success_url` with `session_id`; only http(s) targets are followed. */
export function successRedirect(successUrl: string, sessionId: string): string | null {
  let u: URL;
  try {
    u = new URL(successUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  u.searchParams.set("session_id", sessionId);
  return u.toString();
}

export function safeHttpUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Hosted URL of a session opened from a payment link (`PaymentLinkSession`): the secret must belong to
 * that session, exactly as `/c/:id#<secret>` links are checked. Returns null otherwise.
 */
export function linkSessionPath(sessionId: string, secret: string): string | null {
  const r = parseRoute(`/c/${sessionId}`, `#${secret}`);
  return r.kind === "hosted" && r.secret ? `/c/${sessionId}#${secret}` : null;
}
