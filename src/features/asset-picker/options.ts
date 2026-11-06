/** Which payment options a path can use (lld/checkout-and-js.md §3 `asset-picker`). */
import type { Option, Path } from "../../app/machine";
import { walletAsset } from "../../lib/chains/chains";

export function payableOptions(options: readonly Option[], path: Path, family: "evm" | "near" | null): Option[] {
  const list = options.filter((o) => {
    if (path === "manual") return o.method === "route_quote";
    if (o.method === "intents_transfer") return family !== null;
    const asset = walletAsset(o.origin_asset_id, o.chain);
    if (!asset) return false;
    return family === "evm"
      ? asset.kind.startsWith("evm_")
      : family === "near"
        ? asset.kind.startsWith("near_")
        : false;
  });
  // Server order is "best first"; keep it, but put usable options before unavailable ones.
  return [...list.filter((o) => o.available), ...list.filter((o) => !o.available)];
}

/** Stable key of an option (the same asset can be offered by both methods). */
export const optionKey = (o: Option): string => `${o.method}:${o.origin_asset_id}:${o.chain}`;
