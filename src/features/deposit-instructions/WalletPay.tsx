/** Wallet path (§5.4): one button that builds the attested transfer in the connected wallet. */
import type { Option } from "../../app/machine";
import { chainName, getChain } from "../../lib/chains/chains";
import { t } from "../../lib/i18n/t";
import type { VerifiedInstructions } from "../../lib/integrity/verify";
import { formatBaseUnits } from "../../lib/money/format";
import { Button, Notice } from "../../ui/primitives";
import { Countdown } from "./Countdown";
import { amountLabel } from "./ManualInstructions";

export function WalletPay(props: {
  verified: VerifiedInstructions;
  meta: Option | null;
  testMode: boolean;
  busy: boolean;
  onPay: () => void;
  onSimulate: () => void;
}) {
  const a = props.verified.attestation;
  let label: string;
  let hint: string | null = null;
  if (a.kind === "route_quote" && a.deposit) {
    const [amount, symbol] = splitAmount(amountLabel(a.deposit.amount_in, props.meta, a.deposit.origin_asset_id));
    label = t("pay.wallet.send", { amount, symbol });
    if (getChain(a.deposit.chain)?.family === "evm")
      hint = t("pay.wallet.switchChain", { chain: chainName(a.deposit.chain) });
  } else if (a.requirement) {
    const total = (BigInt(a.requirement.amount) + BigInt(a.requirement.fee_amount)).toString();
    const meta = props.meta;
    const amount = meta ? formatBaseUnits(total, meta.decimals) : total;
    label = t("pay.wallet.sign", { amount, symbol: meta?.symbol ?? "" });
    hint = t("pay.wallet.signHint");
  } else {
    return null;
  }
  return (
    <div className="np-instructions" data-testid="wallet-pay">
      <h2 className="np-h2">{t("pay.wallet.title")}</h2>
      {hint ? <p className="np-help">{hint}</p> : null}
      <p className="np-deadline">
        <Countdown until={props.verified.validUntil} render={(time) => t("deposit.timeLeft", { time })} />
      </p>
      {props.testMode ? (
        <>
          <Notice kind="info">{t("pay.wallet.testMode")}</Notice>
          <Button onClick={props.onSimulate} disabled={props.busy} testId="simulate">
            {props.busy ? t("pay.simulating") : t("pay.simulate")}
          </Button>
        </>
      ) : (
        <Button onClick={props.onPay} disabled={props.busy} testId="wallet-send">
          {props.busy ? t("pay.wallet.sending") : label}
        </Button>
      )}
    </div>
  );
}

function splitAmount(s: string): [string, string] {
  const i = s.lastIndexOf(" ");
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
}
