/**
 * The ATTESTED merchant and destination (§5.2): the verified line on the instructions screens and the
 * "Payment details" sheet (merchant, "Business details declared by the merchant", payment destination,
 * destination fingerprint). Business details are self-declared and go live without a NearPay review
 * (open onboarding, ADR-0024), so the copy
 * never claims a verified identity (ADR-0020, design-system §6.3). The fingerprint keeps the format the
 * merchant sees in the dashboard (`XXXX-XXXX-XX`) so the two can be compared character by character.
 */
import { Button, Callout, Modal, StatusBadge } from "@nearpay-internal/ui";
import { useState } from "react";
import type { ViewModel } from "../../app/model";
import { t } from "../../lib/i18n/t";

/**
 * Design v2 trust line on the instruction screens, shown only once the sentinel co-signature verified
 * (the caller checks `state.verified`): "Payout address verified for <attested merchant>" — what was
 * actually verified — then the declared business details and the "Payment details" sheet.
 */
export function VerifiedMerchant({ vm }: { vm: ViewModel }) {
  const [open, setOpen] = useState(false);
  if (!vm.merchant || !vm.destination) return null;
  return (
    <div className="ck-verified" data-testid="verified-merchant">
      <Callout tone="verified" compact title={t("trust.verified", { merchant: vm.merchant.name })} />
      <p className="ck-verified__meta">
        <span data-testid="kyb-inline">
          {vm.merchant.reviewed ? t("trust.reviewedText") : t("trust.notReviewedText")}
        </span>
        <button type="button" className="np-link-button" onClick={() => setOpen(true)} data-testid="payment-details">
          {t("app.paymentDetails")}
        </button>
      </p>
      <PaymentDetailsSheet vm={vm} open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

export function PaymentDetailsSheet({ vm, open, onClose }: { vm: ViewModel; open: boolean; onClose: () => void }) {
  if (!vm.merchant || !vm.destination) return null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("app.paymentDetails")}
      className="ck-sheet"
      footer={
        <Button fullWidth variant="secondary" onClick={onClose} data-testid="details-back">
          {t("trust.back")}
        </Button>
      }
    >
      <div className="ck-details" data-testid="payment-details-sheet">
        <section className="np-stack" aria-labelledby="ck-details-merchant">
          <h3 className="ck-details__name" id="ck-details-merchant" data-testid="merchant-name">
            {vm.merchant.name}
          </h3>
          <StatusBadge tone={vm.merchant.reviewed ? "success" : "neutral"}>
            {vm.merchant.reviewed ? t("trust.reviewed") : t("trust.notReviewed")}
          </StatusBadge>
          <p data-testid="kyb">{vm.merchant.reviewed ? t("trust.reviewedText") : t("trust.notReviewedText")}</p>
        </section>
        <hr className="np-divider" />
        <section className="np-stack" aria-labelledby="ck-details-dest">
          <h3 className="ck-subtitle" id="ck-details-dest">
            {t("trust.destination")}
          </h3>
          <p data-testid="destination">{vm.destination.assetLabel}</p>
          <p className="np-checkout__note">{t("trust.fingerprint")}</p>
          <p className="ck-fingerprint np-tabular" data-testid="fingerprint">
            {vm.destination.fingerprint}
          </p>
          <p className="np-checkout__lede">{t("trust.fingerprintHelp")}</p>
          <p className="np-checkout__note">{t("trust.settles")}</p>
        </section>
      </div>
    </Modal>
  );
}
