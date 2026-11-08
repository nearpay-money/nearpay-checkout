import "@nearpay-internal/ui/fonts.css";
import "@nearpay-internal/ui/tokens.css";
import "@nearpay-internal/ui/styles.css";
import "./styles.css";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { applyCheckoutAppearance } from "./app/appearance";
import { parseRoute } from "./app/route";
import { t } from "./lib/i18n/t";
import { installBridge } from "./routes/embed/bridge";
import { EmbeddedCheckout } from "./routes/embed/EmbeddedCheckout";
import { DEFAULT_APPEARANCE } from "./routes/embed/protocol";
import { PaymentLinkCheckout } from "./routes/payment-link/PaymentLinkCheckout";
import { HostedCheckout, InvalidLink } from "./routes/session/HostedCheckout";

// Hosted invoices load on demand: the checkout's initial bundle stays within budget (§7).
const InvoicePage = lazy(() => import("./routes/invoice/InvoicePage"));

const route = parseRoute(window.location.pathname, window.location.hash);
// The bridge listens before the first render so an early np:init is not lost.
const bridge = route.kind === "embed" ? installBridge(window) : null;
document.title = t("app.title");
// Theme root on <html>: NearPay defaults (follows the system theme) until a verified parent sends
// the merchant's appearance (embedded mode).
applyCheckoutAppearance(document.documentElement, DEFAULT_APPEARANCE);

function App() {
  switch (route.kind) {
    case "hosted":
      return route.secret ? <HostedCheckout sessionId={route.sessionId} secret={route.secret} /> : <InvalidLink />;
    case "embed":
      return route.secret && bridge ? (
        <EmbeddedCheckout sessionId={route.sessionId} secret={route.secret} bridge={bridge} />
      ) : (
        <InvalidLink />
      );
    case "payment_link":
      return <PaymentLinkCheckout id={route.id} />;
    case "invoice":
      return (
        <Suspense fallback={null}>
          <InvoicePage link={route.invoice} />
        </Suspense>
      );
    default:
      return <InvalidLink />;
  }
}

const el = document.getElementById("root");
if (el) {
  if (route.kind === "embed") document.documentElement.dataset.embedded = "1";
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
