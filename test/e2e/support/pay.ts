/**
 * "Pay with" helpers: the network and token dropdowns (src/ui/Picker.tsx). `choose` picks an option's
 * network, then its token, then Continue — what a payer does with the mouse.
 */

import { SOLANA_MAINNET } from "@nearpay/spec";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { USDC_BASE, USDC_NEAR } from "../../support/sessions";

const NETWORK_OF: Record<string, string> = {
  [USDC_BASE]: "eip155:8453",
  [USDC_NEAR]: "near:mainnet",
  "nep141:eth.omft.near": "eip155:1",
  "nep141:btc.omft.near": "bip122:000000000019d6689c085ae165831e93",
  "nep141:sol.omft.near": SOLANA_MAINNET,
  "nep141:base.omft.near": "eip155:8453",
};

/** Network key of an option as the picker lists it (Intents transfers are their own network). */
export function networkOf(method: string, asset: string): string {
  if (method === "intents_transfer") return "intents";
  const n =
    NETWORK_OF[asset] ??
    (asset.startsWith("nep141:sol-") ? SOLANA_MAINNET : asset.startsWith("nep141:base-") ? "eip155:8453" : undefined);
  if (!n) throw new Error(`no network known for ${asset}`);
  return n;
}

type Root = Page | FrameLocator;

/**
 * Opens a dropdown. Retried because an embedded checkout's iframe is resized by its parent
 * (`np:resize`) right after a screen renders, which can move the trigger under a click in flight.
 */
export async function openPicker(p: Root, id: "network-picker" | "token-picker"): Promise<void> {
  const panel = p.getByTestId(`${id}-panel`);
  await expect(async () => {
    if (!(await panel.isVisible())) await p.getByTestId(`${id}-trigger`).click({ timeout: 2000 });
    await expect(panel).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
}

export async function chooseNetwork(p: Root, network: string): Promise<void> {
  await openPicker(p, "network-picker");
  await p.getByTestId(`network-${network}`).click();
  await expect(p.getByTestId("network-picker-panel")).toHaveCount(0);
}

/** Opens the token dropdown of `network` (the option rows are then visible). */
export async function openTokens(p: Root, method: string, asset: string): Promise<void> {
  await chooseNetwork(p, networkOf(method, asset));
  await openPicker(p, "token-picker");
}

export async function choose(p: Root, method: string, asset: string): Promise<void> {
  await openTokens(p, method, asset);
  await p.getByTestId(`option-${method}-${asset}`).click();
  await expect(p.getByTestId("token-picker-panel")).toHaveCount(0);
  await p.getByTestId("asset-continue").click();
}
