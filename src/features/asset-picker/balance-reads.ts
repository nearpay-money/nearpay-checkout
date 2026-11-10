/**
 * Reads the connected wallet's balances for one network's payment options (lazy chunk, loaded only on
 * the wallet path). EVM through the wallet's own EIP-1193 provider (`eth_call balanceOf`,
 * `eth_getBalance`) and only when the wallet is on that chain; NEAR (`ft_balance_of`, native) and
 * NEAR Intents (`mt_balance_of` on intents.near) through the configured NEAR RPC; Solana
 * (`getBalance`, `getTokenAccountsByOwner`) through the configured Solana RPC. No new hosts (CSP).
 * Any failed read rejects: the picker then falls back to the full list.
 */
import { INTENTS_CONTRACT } from "@nearpay/spec";
import type { Option } from "../../app/machine";
import { erc20BalanceOf, nativeBalance, walletChainId } from "../../wallets/evm/reads";
import { availableNear, ftBalanceOf, mtBalanceOf } from "../../wallets/near/balances";
import { solBalance, splBalances } from "../../wallets/solana/balances";
import type { WalletHandle } from "../wallet-connect/wallets";
import { optionKey } from "./options";
import { type BalanceRead, type BalanceTarget, balanceTarget } from "./tokens";

export interface ReadConfig {
  readonly nearRpcUrl: string;
  readonly solanaRpcUrl: string;
}

export async function readBalances(w: WalletHandle, options: readonly Option[], cfg: ReadConfig): Promise<BalanceRead> {
  const targets: [string, BalanceTarget][] = [];
  for (const o of options) {
    const t = balanceTarget(o, w.family);
    if (t) targets.push([optionKey(o), t]);
  }
  if (targets.length === 0) return { state: "none" };

  if (w.family === "evm") {
    const want = targets.find(([, t]) => t.kind === "erc20" || t.kind === "evm_native")?.[1] as
      | Extract<BalanceTarget, { chainId: number }>
      | undefined;
    if (want && (await walletChainId(w.provider)) !== want.chainId) {
      return { state: "wrong_chain", chain: `eip155:${want.chainId}` };
    }
  }

  let spl: Promise<Map<string, string>> | null = null;
  const one = async (t: BalanceTarget): Promise<string> => {
    switch (t.kind) {
      case "erc20":
      case "evm_native":
        if (w.family !== "evm") throw new Error("not an EVM wallet");
        return (
          t.kind === "erc20"
            ? await erc20BalanceOf(w.provider, t.token, w.address)
            : await nativeBalance(w.provider, w.address)
        ).toString();
      case "nep141":
        return ftBalanceOf(cfg.nearRpcUrl, t.token, w.address);
      case "near_native":
        return availableNear(cfg.nearRpcUrl, w.address);
      case "intents":
        // Intents accounts of EVM signers are the lower-case address (as in the signed intent).
        return mtBalanceOf(
          cfg.nearRpcUrl,
          INTENTS_CONTRACT,
          w.family === "evm" ? w.address.toLowerCase() : w.address,
          t.tokenId,
        );
      case "sol":
        return solBalance(cfg.solanaRpcUrl, w.address);
      case "spl":
        spl ??= splBalances(cfg.solanaRpcUrl, w.address);
        return (await spl).get(t.mint) ?? "0";
    }
  };
  const read = await Promise.all(targets.map(async ([key, t]) => [key, await one(t)] as const));
  return { state: "ok", balances: new Map(read) };
}
