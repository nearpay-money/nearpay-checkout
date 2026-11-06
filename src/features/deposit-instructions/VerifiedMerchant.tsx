import { t } from "../../lib/i18n/t";
import type { VerifiedInstructions } from "../../lib/integrity/verify";

/** The ATTESTED merchant name, KYB badge and destination fingerprint (§5.2; never the payments copy). */
export function VerifiedMerchant({ verified }: { verified: VerifiedInstructions }) {
  const { merchant, destination } = verified.attestation;
  return (
    <div className="np-verified" data-testid="verified-merchant">
      <div className="np-verified-badge">{t("verified.badge")}</div>
      <div className="np-row">
        <span className="np-label">{t("verified.payTo")}</span>
        <span className="np-merchant" data-testid="merchant-name">
          {merchant.name}
        </span>
      </div>
      <div className="np-row">
        <span className={merchant.kyb_verified ? "np-kyb np-kyb-yes" : "np-kyb np-kyb-no"} data-testid="kyb">
          {merchant.kyb_verified ? t("verified.kyb") : t("verified.unverified")}
        </span>
      </div>
      <div className="np-row">
        <span className="np-label">{t("verified.fingerprint")}</span>
        <code className="np-fingerprint" data-testid="fingerprint">
          {destination.fingerprint}
        </code>
      </div>
      <p className="np-help">{t("verified.fingerprintHelp")}</p>
    </div>
  );
}
