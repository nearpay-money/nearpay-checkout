/**
 * "Send from another wallet" (manual path, choose_asset with an option picked): the chosen token and
 * network, the refund address (validated per chain, never an exchange deposit address, §5.5) and the
 * sending-network warning, then "Review transfer details" (attempt + sentinel verification).
 */
import { Button, Callout, Field, Input, SelectionCard } from "@nearpay-internal/ui";
import { useState } from "react";
import type { Option } from "../../app/machine";
import { chainName } from "../../lib/chains/chains";
import { t } from "../../lib/i18n/t";
import { ScreenTitle } from "../../ui/blocks";
import { optionTitle } from "../asset-picker/options";
import { validateRefundAddress } from "./validate";

export function SendFromAnotherWallet({
  option,
  refund,
  onRefund,
  canSubmit,
  busy,
  needsChallenge,
  onChange,
  onSubmit,
}: {
  option: Option;
  refund: string;
  onRefund: (v: string) => void;
  /** A Turnstile token is ready. */
  canSubmit: boolean;
  busy: boolean;
  needsChallenge: boolean;
  onChange: () => void;
  onSubmit: (refundTo: string) => void;
}) {
  const [touched, setTouched] = useState(false);
  const chain = chainName(option.chain);
  const check = validateRefundAddress(option.chain, refund);
  const showError = touched && !check.ok && refund.trim() !== "";
  return (
    <section className="ck-screen" data-testid="refund-form" aria-labelledby="ck-manual-title">
      <ScreenTitle id="ck-manual-title" title={t("manual.title")} />
      <SelectionCard
        avatar={option.symbol}
        title={optionTitle(option)}
        action={
          <button type="button" className="np-link-button" onClick={onChange} data-testid="change-option">
            {t("manual.change")}
          </button>
        }
      />
      <form
        className="np-stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (check.ok && canSubmit && !busy) onSubmit(refund.trim());
        }}
      >
        <Field
          label={t("refund.label")}
          hint={<span data-testid="refund-warning">{t("refund.help")}</span>}
          error={
            showError && !check.ok ? (
              <span data-testid="refund-error">{t(`refund.error.${check.reason}`)}</span>
            ) : undefined
          }
          required
        >
          <Input
            value={refund}
            onChange={(e) => onRefund(e.target.value)}
            onBlur={() => setTouched(true)}
            placeholder={t("refund.placeholder", { chain })}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            inputMode="text"
            data-testid="refund-address"
          />
        </Field>
        <details className="ck-disclosure" data-testid="refund-why">
          <summary className="ck-disclosure__summary">{t("refund.why")}</summary>
          <p className="ck-disclosure__body">{t("refund.whyBody", { chain })}</p>
        </details>
        <Callout tone="warning" title={t("manual.networkTitle")}>
          {t("manual.networkBody", { chain })}
        </Callout>
        <Button
          type="submit"
          fullWidth
          disabled={!check.ok || !canSubmit}
          loading={busy}
          loadingText={t("verify.button")}
          data-testid="continue"
        >
          {t("manual.continue")}
        </Button>
        {needsChallenge && check.ok ? (
          <p className="np-checkout__note" role="status">
            {t("asset.checking")}
          </p>
        ) : null}
      </form>
    </section>
  );
}
