import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { parseRoute } from "./app/route";
import { t } from "./lib/i18n/t";
import { installBridge } from "./routes/embed/bridge";
import { EmbeddedCheckout } from "./routes/embed/EmbeddedCheckout";
import { HostedCheckout, InvalidLink, NotAvailable } from "./routes/session/HostedCheckout";
import "./styles.css";

const route = parseRoute(window.location.pathname, window.location.hash);
// The bridge listens before the first render so an early np:init is not lost.
const bridge = route.kind === "embed" ? installBridge(window) : null;
document.title = t("app.title");

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
      return <NotAvailable what="Payment links arrive in a later release." />;
    case "invoice":
      return <NotAvailable what="Hosted invoices arrive in a later release." />;
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
