/**
 * Payment links `/l/:id` (Stage 2, lld/checkout-and-js.md §1): the anonymous `getPublicPaymentLink`
 * shows what the payer pays for (description, price) in the checkout frame; "Continue to payment" calls
 * `createPaymentLinkSession` and the page continues with the normal session flow (`/c/:id`), the client
 * secret kept in the URL fragment and in memory only (§5.1). The link's unverified merchant name is never
 * rendered (L-CK-03): who is paid is shown from the sentinel attestation, as in every session.
 */

import { createPaymentLinkSession, getPublicPaymentLink, type PublicPaymentLink } from "@nearpay/spec";
import { Button, Callout, CheckoutFrame, Field, Input, KeyValueList, Money, WarningIcon } from "@nearpay-internal/ui";
import { useCallback, useEffect, useState } from "react";
import type { z } from "zod";
import { linkSessionPath } from "../../app/route";
import { LoadingScreen } from "../../app/StatusScreens";
import { webLinks } from "../../config";
import { call, isApiError } from "../../lib/api/client";
import { errorText, t } from "../../lib/i18n/t";
import { priceMoney, pricingAssetMeta } from "../../lib/money/display";
import { ScreenTitle, StateScreen } from "../../ui/blocks";
import { useMediaQuery } from "../../ui/useMediaQuery";
import { HostedCheckout } from "../session/HostedCheckout";

type Link = z.output<typeof PublicPaymentLink>;

type LinkState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly link: Link }
  | { readonly kind: "inactive"; readonly link: Link | null }
  | { readonly kind: "not_found" }
  | { readonly kind: "load_failed"; readonly code: string }
  | { readonly kind: "session"; readonly sessionId: string; readonly secret: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function PaymentLinkCheckout({ id }: { id: string }) {
  const [st, setSt] = useState<LinkState>({ kind: "loading" });
  const [email, setEmail] = useState("");
  const [touched, setTouched] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wide = useMediaQuery("(min-width: 880px)");

  const load = useCallback(() => {
    setSt({ kind: "loading" });
    call(getPublicPaymentLink, { params: { id } })
      .then((link) => setSt(link.active ? { kind: "ready", link } : { kind: "inactive", link }))
      .catch((e) => {
        if (isApiError(e, "resource_missing") || (isApiError(e) && e.status === 404)) setSt({ kind: "not_found" });
        else if (isApiError(e, "link_inactive")) setSt({ kind: "inactive", link: null });
        else setSt({ kind: "load_failed", code: isApiError(e) ? e.code : "generic" });
      });
  }, [id]);
  useEffect(load, [load]);

  if (st.kind === "session") return <HostedCheckout sessionId={st.sessionId} secret={st.secret} />;

  const link = st.kind === "ready" || st.kind === "inactive" ? st.link : null;
  // Asset-priced links: `pricing_asset` (spec 0.2.1) gives decimals/symbol; older servers → base units.
  const price = link ? priceMoney(link, pricingAssetMeta(link.asset_id, link.pricing_asset)) : null;
  const emailOk = EMAIL_RE.test(email.trim()) && email.trim().length <= 254;

  const open = async () => {
    if (st.kind !== "ready") return;
    if (st.link.collect_email && !emailOk) {
      setTouched(true);
      return;
    }
    setOpening(true);
    setError(null);
    try {
      const body: { customer_email?: string; locale?: string } = {};
      if (st.link.collect_email) body.customer_email = email.trim();
      const r = await call(createPaymentLinkSession, { params: { id }, body });
      const path = linkSessionPath(r.checkout_session, r.client_secret);
      if (!path) throw new Error("invalid session");
      // Same URL shape as a hosted checkout link, so a reload resumes this session (§5.1).
      window.history.replaceState(null, "", path);
      setSt({ kind: "session", sessionId: r.checkout_session, secret: r.client_secret });
    } catch (e) {
      if (isApiError(e, "link_inactive")) setSt({ kind: "inactive", link: st.link });
      else setError(isApiError(e) ? errorText(e.code) : errorText("invalid_response"));
    } finally {
      setOpening(false);
    }
  };

  const body = (() => {
    switch (st.kind) {
      case "loading":
        return <LoadingScreen />;
      case "not_found":
        return (
          <StateScreen
            testId="link-not-found"
            icon={<WarningIcon />}
            title={t("link.notFoundTitle")}
            body={t("link.notFoundBody")}
          />
        );
      case "load_failed":
        return (
          <StateScreen
            testId="link-load-failed"
            icon={<WarningIcon />}
            title={t("link.loadFailed")}
            body={errorText(st.code)}
            actions={
              <Button fullWidth onClick={load} data-testid="link-retry">
                {t("link.retry")}
              </Button>
            }
          />
        );
      case "inactive":
        return (
          <StateScreen
            testId="link-inactive"
            icon={<WarningIcon />}
            title={t("link.inactiveTitle")}
            body={t("link.inactiveBody")}
            badge={t("link.inactiveBadge")}
          />
        );
      case "ready":
        return (
          <section className="ck-screen" data-testid="payment-link" aria-labelledby="ck-link-title">
            <ScreenTitle
              id="ck-link-title"
              title={wide ? t("start.titleEmbed") : st.link.display.description}
              lede={t("start.lede")}
            />
            {error ? <Callout tone="danger" title={error} live data-testid="error" /> : null}
            <form
              className="np-stack"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                void open();
              }}
            >
              {st.link.collect_email ? (
                <Field
                  label={t("link.email")}
                  hint={t("link.emailHint")}
                  error={touched && !emailOk ? t("link.emailInvalid") : undefined}
                  required
                >
                  <Input
                    type="email"
                    autoComplete="email"
                    inputMode="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onBlur={() => setTouched(true)}
                    data-testid="link-email"
                  />
                </Field>
              ) : null}
              <Button
                type="submit"
                fullWidth
                loading={opening}
                loadingText={t("link.opening")}
                data-testid="link-continue"
              >
                {t("link.cta")}
              </Button>
            </form>
            <Callout tone="info" title={t("start.noAccount")} reference={t("start.noAccountBody")} />
          </section>
        );
    }
  })();

  return (
    <CheckoutFrame
      amount={
        link ? (
          <span data-testid="price">{price ? <Money {...price} size="hero" /> : `${link.amount}`}</span>
        ) : undefined
      }
      summary={
        link && wide ? (
          <>
            <h2 className="ck-summary-title">{link.display.description}</h2>
            <hr className="np-divider" />
            <KeyValueList
              items={[{ label: t("summary.subtotal"), value: price ? <Money {...price} /> : `${link.amount}` }]}
            />
          </>
        ) : undefined
      }
      banner={
        link && !link.livemode ? (
          <Callout tone="info" title={t("app.testmode")} reference={t("app.testmodeRef")} data-testid="test-banner" />
        ) : undefined
      }
      links={webLinks}
      className="ck-frame"
    >
      <div className="ck-flow">{body}</div>
    </CheckoutFrame>
  );
}
