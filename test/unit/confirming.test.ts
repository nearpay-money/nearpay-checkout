/** ADR-0022 copy: "Payment received — confirming on <chain>" and the "Check status" feedback label. */
import { describe, expect, it } from "vitest";
import { checkedAtLabel, confirmingBody, FAST_CONFIRMING_CHAINS } from "../../src/app/screens";
import { t } from "../../src/lib/i18n/t";

const text = (b: ReturnType<typeof confirmingBody>) => t(b.key, b.chain ? { chain: b.chain } : {});

describe("confirming frame body", () => {
  it("while verifying, names the destination chain; L2s (Base, Arbitrum) say it usually takes under a minute", () => {
    expect(text(confirmingBody("verifying", "eip155:8453"))).toBe(
      "Payment received — confirming on Base (usually under a minute).",
    );
    expect(text(confirmingBody("verifying", "eip155:42161"))).toMatch(
      /^Payment received — confirming on Arbitrum.* \(usually under a minute\)\.$/,
    );
    expect(FAST_CONFIRMING_CHAINS.has("near:mainnet")).toBe(true);
  });

  it("Ethereum (finalized, ~15 min) gets no time promise", () => {
    expect(confirmingBody("verifying", "eip155:1").key).toBe("confirming.bodyChain");
    expect(text(confirmingBody("verifying", "eip155:1"))).toMatch(/^Payment received — confirming on Ethereum\.$/);
  });

  it("before verifying, or without an attested destination, the generic text", () => {
    for (const [status, chain] of [
      ["deposit_detected", "eip155:8453"],
      ["settling", "eip155:8453"],
      ["verifying", null],
      [undefined, "eip155:8453"],
    ] as const)
      expect(confirmingBody(status, chain)).toEqual({ key: "confirming.body" });
  });
});

describe("Check status feedback", () => {
  it("formats the check time as HH:MM:SS (24 h, zero-padded)", () => {
    expect(checkedAtLabel(new Date(2026, 10, 10, 8, 5, 3))).toBe("08:05:03");
    expect(checkedAtLabel(new Date(2026, 10, 10, 23, 59, 59))).toBe("23:59:59");
    expect(t("slow.checked", { time: "08:05:03" })).toBe("Still confirming · checked 08:05:03");
  });
});
