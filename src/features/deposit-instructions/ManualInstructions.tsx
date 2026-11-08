/**
 * Manual path (§5.5–§5.8): "Send <amount>" with the network callout first, "I'm sending on <network>",
 * the memo with its own confirmation, and only then the deposit address (copy + QR), the exact amount
 * and the expiry — all from the ATTESTED instructions. "I've sent the payment" stays disabled until the
 * confirmations are ticked; test mode adds "Simulate payment". Also renders "We received less than
 * expected" (needs_top_up) with the same guarded instructions for the remainder.
 */
import { Button, Callout, Card, Checkbox, CopyField, KeyValueList, Money } from "@nearpay-internal/ui";
import { useState } from "react";
import { moneyText, referenceText, type ViewModel } from "../../app/model";
import type { Checkout } from "../../app/useCheckout";
import { chainName, walletAsset } from "../../lib/chains/chains";
import { t } from "../../lib/i18n/t";
import { assetMoney, receivedSoFar, walletTokenHint } from "../../lib/money/display";
import { CopyTextButton, ScreenTitle } from "../../ui/blocks";
import { QrCode } from "./QrCode";
import { qrPayload } from "./qr";
import { withCountdown } from "./WalletPay";

export function ManualInstructions({ c, vm, topUp }: { c: Checkout; vm: ViewModel; topUp: boolean }) {
  const v = c.state.verified;
  const d = v?.attestation.deposit;
  const [network, setNetwork] = useState(false);
  const [memo, setMemo] = useState(false);
  if (!v || !d) return null;
  const chain = chainName(d.chain);
  const symbol = vm.asset?.symbol ?? "";
  const ready = network && (d.memo === null || memo);
  const amount = assetMoney(d.amount_in, vm.asset);
  const amountLabel = moneyText(amount, `${d.amount_in} base units (${d.origin_asset_id})`);
  // QR: EIP-681 needs the token contract; derived from the attested asset id (or the signed
  // `Attestation.asset.token`, spec 0.2.1, else the option's typed token for the same asset and chain).
  const opt = [c.state.option, c.originMeta].find(
    (o) => o?.origin_asset_id === d.origin_asset_id && o.chain === d.chain,
  );
  const recipe = walletAsset(d.origin_asset_id, d.chain, walletTokenHint(v.attestation, opt?.token));
  // "Received" / "Still to send" (PayerAttempt.amount_received, spec 0.2.1; display only).
  const got =
    topUp && c.state.attempt?.id === v.attestation.attempt_id
      ? receivedSoFar(d.amount_in, c.state.attempt.amount_received)
      : null;
  const money = (x: string) => {
    const m = assetMoney(x, vm.asset);
    return m ? <Money {...m} /> : `${x} base units`;
  };
  const expires = <span data-testid="countdown">{withCountdown(t("deposit.expiresIn"), v.validUntil)}</span>;

  return (
    <section className="ck-screen" data-testid="manual-instructions" aria-labelledby="ck-send-title">
      {topUp ? (
        <>
          <Callout
            tone="warning"
            title={t("less.callout")}
            reference={vm.reference ? referenceText(vm.reference, vm.merchant?.name ?? null) : undefined}
            live
            data-testid="top-up"
          />
          <ScreenTitle id="ck-send-title" title={t("less.title")} lede={t("less.body")} />
          <KeyValueList
            items={[
              { label: t("less.expected"), value: amount ? <Money {...amount} /> : amountLabel },
              ...(got
                ? [{ label: t("less.received"), value: <span data-testid="received">{money(got.received)}</span> }]
                : []),
              ...(got?.remaining
                ? [
                    {
                      label: t("less.remaining"),
                      value: <span data-testid="remaining">{money(got.remaining)}</span>,
                      total: true,
                    },
                  ]
                : []),
            ]}
          />
        </>
      ) : (
        <ScreenTitle
          id="ck-send-title"
          title={t("deposit.title", { amount: amountLabel })}
          lede={
            vm.merchant
              ? t("deposit.to", { merchant: vm.merchant.name, price: vm.priceText })
              : t("deposit.toUnknown", { price: vm.priceText })
          }
        />
      )}
      {c.state.replacedAttempt ? <Callout tone="warning" title={t("deposit.replaced")} data-testid="replaced" /> : null}
      <Callout tone="warning" title={t("deposit.networkTitle", { chain })} data-testid="network">
        {t("deposit.networkBody", { token: symbol || d.origin_asset_id, chain })}
      </Callout>
      <Checkbox
        variant="tile"
        label={t("deposit.confirmNetwork", { chain })}
        checked={network}
        onChange={(e) => setNetwork(e.target.checked)}
        data-testid="confirm-network"
      />
      {d.memo !== null ? (
        <Card padding="md" className="ck-deposit">
          <div className="np-stack np-stack--sm">
            <p className="np-copy-field__label">{t("deposit.memo")}</p>
            <p className="ck-mono" data-testid="memo">
              {d.memo}
            </p>
            <CopyTextButton
              value={d.memo}
              label={t("deposit.copyMemo")}
              copiedLabel={t("deposit.memoCopied")}
              failedLabel={d.memo}
              variant="secondary"
              testId="copy-memo"
            />
          </div>
          <Checkbox
            variant="tile"
            label={t("deposit.confirmMemo")}
            checked={memo}
            onChange={(e) => setMemo(e.target.checked)}
            data-testid="confirm-memo"
          />
        </Card>
      ) : null}
      {ready ? (
        <>
          <div data-testid="deposit-address">
            <CopyField
              label={t("deposit.address")}
              value={d.address}
              footer={
                <div className="ck-deposit__footer">
                  {expires}
                  <QrCode value={qrPayload(d.address, d.amount_in, recipe)} label={t("deposit.qr")} />
                </div>
              }
            />
          </div>
          <KeyValueList
            items={[
              {
                label: t("deposit.exactAmount"),
                value: (
                  <strong className="ck-amount" data-testid="amount-in">
                    {amountLabel}
                  </strong>
                ),
              },
            ]}
          />
        </>
      ) : (
        <p className="np-checkout__note" data-testid="reveal-hint">
          {d.memo !== null ? t("deposit.revealMemo") : t("deposit.reveal")} {expires}
        </p>
      )}
      <div className="np-stack">
        <Button fullWidth onClick={() => void c.actions.signalSent()} disabled={!ready || c.busy} data-testid="sent">
          {t("deposit.sent")}
        </Button>
        {vm.testMode ? (
          <Button
            fullWidth
            variant="secondary"
            onClick={() => void c.actions.simulate()}
            loading={c.busy}
            loadingText={t("test.simulating")}
            data-testid="simulate"
          >
            {t("test.simulate")}
          </Button>
        ) : null}
        <p className="np-checkout__note">{t("deposit.sentNote")}</p>
      </div>
    </section>
  );
}
