/** Lazy entry of the hosted invoice route `/i/:id` (default export for `React.lazy`). */
import { HostedInvoice, InvoiceNotFound } from "./HostedInvoice";
import { invoiceLink } from "./model";

export default function InvoicePage({ link }: { link: { readonly id: string; readonly secret: string } | null }) {
  // A malformed id or secret shows the same "not found" as a wrong secret, without an API call.
  const ok = link ? invoiceLink(link.id, link.secret) : null;
  return ok ? <HostedInvoice id={ok.id} secret={ok.secret} /> : <InvoiceNotFound />;
}
