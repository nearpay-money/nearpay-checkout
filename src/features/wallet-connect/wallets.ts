/** Connected-wallet handles kept outside React state (providers are not serialisable). */
import type { Eip1193Provider } from "../../wallets/evm/provider";
import type { NearWallet } from "../../wallets/near/connector";
import type { SolanaWallet } from "../../wallets/solana/standard";

export type WalletHandle =
  | { readonly family: "evm"; readonly address: string; readonly label: string; readonly provider: Eip1193Provider }
  | { readonly family: "near"; readonly address: string; readonly label: string; readonly wallet: NearWallet }
  | { readonly family: "solana"; readonly address: string; readonly label: string; readonly wallet: SolanaWallet };

/** Shortens `0x1234…abcd` / long NEAR implicit accounts for display. */
export function shortAddress(a: string): string {
  return a.length > 20 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
}
