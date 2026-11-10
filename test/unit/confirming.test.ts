/**
 * ADR-0022 (as amended 2026-11-10 17:10: one block on every chain) copy: "Payment received — confirming on <chain>…
 * usually a few seconds" and the "Check status" feedback label.
 */
import { describe, expect, it } from "vitest";
import { checkedAtLabel, confirmingBody, FAST_CONFIRMING_CHAINS } from "../../src/app/screens";
import { t } from "../../src/lib/i18n/t";

const text = (b: ReturnType<typeof confirmingBody>) => t(b.key, b.chain ? { chain: b.chain } : {});

describe("confirming frame body", () => {
  it("while verifying, names the destination chain and says it usually takes a few seconds (Base, Arbitrum)", () => {
    expect(text(confirmingBody("verifying", "eip155:8453"))).toBe(
      "Payment received — confirming on Base… usually a few seconds",
    );
    expect(text(confirmingBody("verifying", "eip155:42161"))).toMatch(
      /^Payment received — confirming on Arbitrum.*… usually a few seconds$/,
    );
  });

  it("Ethereum too now (one block, not `finalized`), NEAR, Solana and the other EVM chains", () => {
    expect(text(confirmingBody("verifying", "eip155:1"))).toBe(
      "Payment received — confirming on Ethereum… usually a few seconds",
    );
    for (const chain of ["near:mainnet", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "eip155:10", "eip155:137"]) {
      expect(FAST_CONFIRMING_CHAINS.has(chain)).toBe(true);
      expect(confirmingBody("verifying", chain).key).toBe("confirming.bodyChainFast");
    }
  });

  it("Bitcoin (one confirmation ≈ a 10-minute block) gets no time promise", () => {
    const btc = "bip122:000000000019d6689c085ae165831e93";
    expect(confirmingBody("verifying", btc).key).toBe("confirming.bodyChain");
    expect(text(confirmingBody("verifying", btc))).toMatch(/^Payment received — confirming on Bitcoin\.$/);
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
