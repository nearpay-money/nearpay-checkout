/**
 * The ATTESTED merchant and destination (§5.2): a compact trust row on the instructions screens and the
 * "Payment details" sheet (merchant, "Business details reviewed by NearPay", payment destination,
 * destination fingerprint). Business details are self-declared and reviewed by NearPay ops, so the copy
 * never claims a verified identity (ADR-0020, design-system §6.3). The fingerprint keeps the format the
 * merchant sees in the dashboard (`XXXX-XXXX-XX`) so the two can be compared character by character.
 */
import { Button, Modal, ShieldCheckIcon, StatusBadge } from "@nearpay-internal/ui";
import { useState } from "react";
import type { ViewModel } from "../../app/model";
import { t } from "../../lib/i18n/t";

export function TrustRow({ vm }: { vm: ViewModel }) {
  const [open, setOpen] = useState(false);
  if (!vm.merchant || !vm.destination) return null;
  return (
    <div className="ck-trust" data-testid="verified-merchant">
      <span className="ck-trust__text">
        <ShieldCheckIcon size={16} />
        <span data-testid="kyb-inline">
          {vm.merchant.reviewed ? t("trust.reviewedText") : t("trust.notReviewedText")}
        </span>
      </span>
      <button type="button" className="np-link-button" onClick={() => setOpen(true)} data-testid="payment-details">
        {t("app.paymentDetails")}
      </button>
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
