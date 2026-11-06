/**
 * Manual path (§5.5–§5.8): network guard first, memo with its own confirmation, then amount, address and
 * QR — all from the ATTESTED instructions — the countdown to the attested deadline, "I've sent it",
 * and "Simulate payment" in test mode.
 */
import { useId, useState } from "react";
import type { Option } from "../../app/machine";
import { chainName, walletAsset } from "../../lib/chains/chains";
import { t } from "../../lib/i18n/t";
import type { VerifiedInstructions } from "../../lib/integrity/verify";
import { formatBaseUnits } from "../../lib/money/format";
import { Button, Notice } from "../../ui/primitives";
import { Countdown } from "./Countdown";
import { QrCode } from "./QrCode";
import { qrPayload } from "./qr";

export function amountLabel(amountIn: string, meta: Option | null, assetId: string): string {
  return meta && meta.origin_asset_id === assetId
    ? `${formatBaseUnits(amountIn, meta.decimals)} ${meta.symbol}`
    : `${amountIn} (${assetId})`;
}

function CopyButton({ value, testId }: { value: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      kind="secondary"
      testId={testId}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => undefined,
        );
      }}
    >
      {copied ? t("deposit.copied") : t("deposit.copy")}
    </Button>
  );
}

export function ManualInstructions(props: {
  verified: VerifiedInstructions;
  meta: Option | null;
  testMode: boolean;
  topUp: boolean;
  busy: boolean;
  onSent: () => void;
  onSimulate: () => void;
}) {
  const d = props.verified.attestation.deposit;
  const [network, setNetwork] = useState(false);
  const [memo, setMemo] = useState(false);
  const netId = useId();
  const memoId = useId();
  if (!d) return null;
  const chain = chainName(d.chain);
  const ready = network && (d.memo === null || memo);
  const asset = walletAsset(d.origin_asset_id, d.chain);
  return (
    <div className="np-instructions" data-testid="manual-instructions">
      {props.topUp ? (
        <Notice kind="warn" testId="top-up">
          <strong>{t("deposit.topUp.title")}</strong> {t("deposit.topUp.body")}
        </Notice>
      ) : null}
      <div className="np-network" data-testid="network">
        <span className="np-chain-icon" aria-hidden="true">
          {chain.slice(0, 1)}
        </span>
        <strong>{t("deposit.network", { chain })}</strong>
      </div>
      <label className="np-check" htmlFor={netId}>
        <input
          id={netId}
          type="checkbox"
          checked={network}
          onChange={(e) => setNetwork(e.target.checked)}
          data-testid="confirm-network"
        />
        {t("deposit.confirmNetwork", { chain })}
      </label>
      {d.memo !== null ? (
        <>
          <div className="np-field">
            <span className="np-label">{t("deposit.memo")}</span>
            <code className="np-mono" data-testid="memo">
              {d.memo}
            </code>
            <CopyButton value={d.memo} testId="copy-memo" />
          </div>
          <label className="np-check" htmlFor={memoId}>
            <input
              id={memoId}
              type="checkbox"
              checked={memo}
              onChange={(e) => setMemo(e.target.checked)}
              data-testid="confirm-memo"
            />
            {t("deposit.confirmMemo")}
          </label>
        </>
      ) : null}
      {ready ? (
        <>
          <div className="np-field">
            <span className="np-label">{t("deposit.amount")}</span>
            <strong className="np-amount" data-testid="amount-in">
              {amountLabel(d.amount_in, props.meta, d.origin_asset_id)}
            </strong>
          </div>
          <div className="np-field">
            <span className="np-label">{t("deposit.address")}</span>
            <code className="np-mono np-address" data-testid="deposit-address">
              {d.address}
            </code>
            <CopyButton value={d.address} testId="copy-address" />
          </div>
          <QrCode value={qrPayload(d.address, d.amount_in, asset)} label={t("deposit.qr")} />
        </>
      ) : (
        <p className="np-help" data-testid="reveal-hint">
          {t("deposit.reveal")}
        </p>
      )}
      <p className="np-deadline">
        <Countdown until={props.verified.validUntil} render={(time) => t("deposit.timeLeft", { time })} />
      </p>
      <div className="np-actions">
        <Button onClick={props.onSent} disabled={!ready || props.busy} testId="sent">
          {t("deposit.sent")}
        </Button>
        {props.testMode ? (
          <Button kind="secondary" onClick={props.onSimulate} disabled={props.busy} testId="simulate">
            {props.busy ? t("pay.simulating") : t("pay.simulate")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
