/**
 * Design v2 order summary (ui 0.5.0): the navy order side of the desktop split layout (≥ 960 px; line
 * items, "You send", "How your payment travels") and, on phones, the same content collapsed into a
 * header (merchant or description + amount) with an "Order details" disclosure. Shared by hosted
 * checkout, payment links and hosted invoices; the embedded card uses the same parts on its own
 * surface (no navy: the merchant theme applies there).
 *
 * Who is paid is only ever the ATTESTED merchant (§5.2, L-CK-03): callers pass `merchant` from a
 * verified attestation or nothing; the route then ends at "The merchant's wallet".
 */
import { Avatar, cx, type KeyValueItem, KeyValueList, RouteDiagram } from "@nearpay-internal/ui";
import type { ReactNode } from "react";
import { t } from "../lib/i18n/t";

/** Desktop split from this width (owner brief: ≥ 960 px; below it the single-column layout). */
export const WIDE_QUERY = "(min-width: 960px)";

/** Line items: rows with a total row ("You send" / "Total") under a divider. */
export function OrderLines({ items }: { items: readonly KeyValueItem[] }) {
  return <KeyValueList className="ck-order-lines" items={[...items]} />;
}

/**
 * "How your payment travels: USDC on Base → Acme GmbH's wallet". `from` is the chosen or attested
 * token and network (null before a choice), `merchant` the attested name (null before verification).
 */
export function PaymentRoute({ from, merchant }: { from: string | null; merchant: string | null }) {
  return (
    <RouteDiagram
      className="ck-route"
      title={t("route.title")}
      stops={[from ?? t("route.fromAny"), merchant ? t("route.to", { merchant }) : t("route.toUnknown")]}
      note={t("route.note")}
    />
  );
}

/** `{token} on {network}` for the route's first stop. */
export function routeFrom(token: string | null | undefined, network: string | null | undefined): string | null {
  return token && network ? t("route.from", { token, network }) : null;
}

/**
 * Phones (< 960 px): the order summary as a header — attested merchant (or the description before
 * verification) and the amount — with the line items and the route in an "Order details" disclosure.
 * Hosted pages put it on navy; the embedded card keeps the merchant's own surface.
 */
export function OrderHeader({
  merchant,
  site,
  title,
  amount,
  details,
  navy,
}: {
  /** Attested merchant name; null → `title` leads. */
  merchant: string | null;
  /** Merchant site line under the attested name. */
  site?: string | null;
  /** Description shown when there is no attested merchant yet. */
  title?: ReactNode;
  amount: ReactNode;
  /** Content of the "Order details" disclosure (line items, route). */
  details?: ReactNode;
  navy: boolean;
}) {
  return (
    <section
      className={cx("ck-order", navy ? "np-surface-navy" : "ck-order--plain")}
      aria-label={t("summary.title")}
      data-testid="order-header"
    >
      <div className="ck-order__head">
        {merchant ? (
          <div className="np-checkout__merchant ck-order__merchant">
            <Avatar initial={merchant} shape="square" size="md" />
            <div className="np-checkout__merchant-text">
              <p className="np-checkout__merchant-name">{merchant}</p>
              {site ? <p className="np-checkout__merchant-sub">{site}</p> : null}
            </div>
          </div>
        ) : (
          <p className="ck-order__title">{title}</p>
        )}
        {amount ? <p className="ck-order__amount np-tabular">{amount}</p> : null}
      </div>
      {details ? (
        <details className="ck-disclosure ck-order__details" data-testid="order-details">
          <summary className="ck-disclosure__summary">{t("summary.details")}</summary>
          <div className="ck-order__body">{details}</div>
        </details>
      ) : null}
    </section>
  );
}

/** The item label above the desktop amount hero ("Pro plan, monthly"), then the amount. */
export function AmountWithLabel({ label, amount }: { label: ReactNode; amount: ReactNode }) {
  return (
    <>
      {label ? (
        <span className="ck-order-item" data-testid="description">
          {label}
        </span>
      ) : null}
      {amount}
    </>
  );
}

/** Hostname of the merchant's return URL (hosted sessions), shown under the attested name. */
export function siteOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.hostname : null;
  } catch {
    return null;
  }
}
