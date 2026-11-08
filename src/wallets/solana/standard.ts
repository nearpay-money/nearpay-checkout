/**
 * Solana wallets through the Wallet Standard (lld/checkout-and-js.md §11): `@wallet-standard/app`
 * `getWallets()` discovery of wallets that support `standard:connect` and
 * `solana:signAndSendTransaction` on `solana:mainnet` (Phantom, Solflare, Backpack, …). Loaded lazily
 * from the wallet list, like the other wallet SDKs (§7 budget). Icons are shown only as `data:` URIs
 * (CSP `img-src 'self' data:`).
 */
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import bs58 from "bs58";
import { safeIcon, WalletRejected } from "../evm/provider";
import { isSolanaAddress } from "./tx";

/** Wallet Standard chain id of Solana mainnet. */
export const WS_SOLANA_MAINNET = "solana:mainnet";
const CONNECT = "standard:connect";
const SIGN_AND_SEND = "solana:signAndSendTransaction";

interface ConnectFeature {
  connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }>;
}
interface SignAndSendFeature {
  signAndSendTransaction(
    ...inputs: { account: WalletAccount; chain: string; transaction: Uint8Array; options?: object }[]
  ): Promise<readonly { signature: Uint8Array }[]>;
}

export interface DiscoveredSolanaWallet {
  readonly id: string;
  readonly name: string;
  readonly icon: string | null;
  readonly wallet: Wallet;
}

export interface SolanaWallet {
  readonly address: string;
  readonly label: string;
  /** Signs and sends an unsigned wire transaction; returns the base58 signature (the tx hash). */
  signAndSendTransaction(transaction: Uint8Array): Promise<string>;
}

function usable(w: Wallet): boolean {
  return w.chains.includes(WS_SOLANA_MAINNET) && CONNECT in w.features && SIGN_AND_SEND in w.features;
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "wallet";

function toDiscovered(w: Wallet): DiscoveredSolanaWallet {
  return { id: slug(w.name), name: w.name.slice(0, 40), icon: safeIcon(w.icon), wallet: w };
}

/** Solana wallets registered now; `onChange` fires when wallets register or unregister later. */
export function discoverSolanaWallets(onChange: (list: DiscoveredSolanaWallet[]) => void): () => void {
  const api = getWallets();
  const emit = () => {
    const seen = new Set<string>();
    const list: DiscoveredSolanaWallet[] = [];
    for (const w of api.get()) {
      if (!usable(w)) continue;
      const d = toDiscovered(w);
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      list.push(d);
    }
    onChange(list);
  };
  emit();
  const off1 = api.on("register", emit);
  const off2 = api.on("unregister", emit);
  return () => {
    off1();
    off2();
  };
}

const rejected = (e: unknown): boolean => {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : String(e);
  return code === 4001 || /reject|denied|declined|cancel/i.test(msg);
};

/** Connects a discovered wallet and returns its first Solana mainnet account. */
export async function connectSolanaWallet(d: DiscoveredSolanaWallet): Promise<SolanaWallet> {
  const w = d.wallet;
  const connect = w.features[CONNECT] as ConnectFeature | undefined;
  const send = w.features[SIGN_AND_SEND] as SignAndSendFeature | undefined;
  if (!connect || !send) throw new Error("This wallet can't send Solana transactions.");
  let accounts: readonly WalletAccount[];
  try {
    accounts = (await connect.connect()).accounts;
  } catch (e) {
    throw rejected(e) ? new WalletRejected() : e;
  }
  const account = accounts.find(
    (a) => a.chains.includes(WS_SOLANA_MAINNET) && a.features.includes(SIGN_AND_SEND) && isSolanaAddress(a.address),
  );
  if (!account) throw new Error("The wallet returned no Solana account.");
  return {
    address: account.address,
    label: d.name,
    async signAndSendTransaction(transaction) {
      let out: readonly { signature: Uint8Array }[];
      try {
        out = await send.signAndSendTransaction({ account, chain: WS_SOLANA_MAINNET, transaction });
      } catch (e) {
        if (rejected(e)) throw new WalletRejected();
        throw new SolanaSendFailed(e instanceof Error ? e.message : String(e));
      }
      const sig = out[0]?.signature;
      if (!(sig instanceof Uint8Array) || sig.length !== 64) throw new SolanaSendFailed("no signature returned");
      return bs58.encode(sig);
    },
  };
}

/** The wallet could not send the transaction (not a rejection): "Transaction failed in your wallet". */
export class SolanaSendFailed extends Error {
  constructor(message: string) {
    super(message.slice(0, 200));
    this.name = "SolanaSendFailed";
  }
}
