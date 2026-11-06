/** Asset choice (§4 choose_asset): options, refund address on the manual path, Turnstile, continue. */
import { useId, useState } from "react";
import type { Option, Path } from "../../app/machine";
import { chainName } from "../../lib/chains/chains";
import { hasMessage, t } from "../../lib/i18n/t";
import { formatBaseUnits } from "../../lib/money/format";
import { Button, Spinner } from "../../ui/primitives";
import { validateRefundAddress } from "../refund-address/validate";
import { TurnstileWidget } from "../wallet-connect/TurnstileWidget";
import { optionKey } from "./options";

export function AssetPicker(props: {
  options: readonly Option[] | null;
  selected: Option | null;
  path: Path;
  busy: boolean;
  attemptSeq: string;
  /** Refund address, kept by the parent so it survives a failed attempt. */
  refund: string;
  onRefund: (v: string) => void;
  onSelect: (o: Option) => void;
  onConfirm: (input: { refundTo?: string; turnstileToken: string }) => void;
}) {
  const { refund, onRefund: setRefund } = props;
  const [touched, setTouched] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const refundId = useId();
  const { options, selected } = props;
  if (options === null) return <Spinner label={t("asset.loading")} />;
  if (options.length === 0) return <p className="np-help">{t("asset.none")}</p>;

  const needsRefund = props.path === "manual" && selected?.method === "route_quote";
  const check = needsRefund && selected ? validateRefundAddress(selected.chain, refund) : null;
  const refundOk = !needsRefund || check?.ok === true;
  const canContinue = Boolean(selected) && refundOk && token !== null && !props.busy;

  return (
    <div className="np-assets" data-testid="asset-picker">
      <h2 className="np-h2">{t("asset.title")}</h2>
      <ul className="np-list" aria-label={t("asset.title")}>
        {options.map((o) => {
          const key = optionKey(o);
          const reasonKey = `asset.unavailable.${o.reason ?? "route_unavailable"}`;
          return (
            <li key={key}>
              <label
                className={`np-option${o.available ? "" : " np-option-off"}`}
                data-testid={`option-${o.method}-${o.origin_asset_id}`}
              >
                <input
                  type="radio"
                  name="np-option"
                  checked={selected !== null && optionKey(selected) === key}
                  disabled={!o.available || props.busy}
                  onChange={() => props.onSelect(o)}
                />
                <span className="np-option-main">
                  <strong>{o.symbol}</strong>{" "}
                  <span className="np-muted">
                    {o.method === "intents_transfer"
                      ? t("asset.intents")
                      : t("asset.on", { chain: chainName(o.chain) })}
                  </span>
                </span>
                <span className="np-option-side">
                  {o.available
                    ? o.estimated_amount_in
                      ? t("asset.estimate", {
                          amount: formatBaseUnits(o.estimated_amount_in, o.decimals),
                          symbol: o.symbol,
                        })
                      : ""
                    : hasMessage(reasonKey)
                      ? t(reasonKey)
                      : t("asset.unavailable.route_unavailable")}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {needsRefund && selected ? (
        <div className="np-field">
          <label className="np-label" htmlFor={refundId}>
            {t("refund.label", { chain: chainName(selected.chain) })}
          </label>
          <input
            id={refundId}
            className="np-input"
            value={refund}
            onChange={(e) => setRefund(e.target.value)}
            onBlur={() => setTouched(true)}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={touched && check?.ok === false}
            data-testid="refund-address"
          />
          <p className="np-help">{t("refund.help")}</p>
          <p className="np-warn" data-testid="refund-warning">
            {t("refund.warning")}
          </p>
          {touched && check && !check.ok ? (
            <p className="np-error" role="alert" data-testid="refund-error">
              {t(`refund.error.${check.reason}`)}
            </p>
          ) : null}
        </div>
      ) : null}
      {selected ? <TurnstileWidget onToken={setToken} resetKey={props.attemptSeq} /> : null}
      <Button
        onClick={() =>
          token &&
          props.onConfirm(needsRefund ? { refundTo: refund.trim(), turnstileToken: token } : { turnstileToken: token })
        }
        disabled={!canContinue}
        testId="continue"
      >
        {t("asset.continue")}
      </Button>
    </div>
  );
}
