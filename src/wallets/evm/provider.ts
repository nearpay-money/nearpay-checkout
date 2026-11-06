/**
 * EIP-1193 wallets discovered with EIP-6963 (injected browser wallets). WalletConnect is a separate,
 * lazily loaded adapter. Only the calls the payment needs: accounts, chain switch, send, personal_sign.
 */
import { getChain } from "../../lib/chains/chains";
import { type EvmTxRequest, hexChainId } from "./tx";

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
}

export interface Eip6963ProviderInfo {
  readonly uuid: string;
  readonly name: string;
  readonly icon: string;
  readonly rdns: string;
}

export interface DiscoveredWallet {
  readonly info: Eip6963ProviderInfo;
  readonly provider: Eip1193Provider;
}

/** Collects EIP-6963 announcements for `waitMs`. */
export function discoverInjectedWallets(win: Window, waitMs = 400): Promise<DiscoveredWallet[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredWallet>();
    const onAnnounce = (e: Event) => {
      const d = (e as CustomEvent<DiscoveredWallet>).detail;
      if (!d?.info?.uuid || typeof d.provider?.request !== "function") return;
      if (typeof d.info.name !== "string" || d.info.name.length > 100) return;
      found.set(d.info.uuid, { info: d.info, provider: d.provider });
    };
    win.addEventListener("eip6963:announceProvider", onAnnounce);
    win.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      win.removeEventListener("eip6963:announceProvider", onAnnounce);
      resolve([...found.values()]);
    }, waitMs);
  });
}

/** Wallet icons must be data: images (CSP img-src 'self' data:). */
export function safeIcon(icon: string): string | null {
  return /^data:image\/(svg\+xml|png|webp|jpeg|gif)[;,]/.test(icon) ? icon : null;
}

export class WalletRejected extends Error {
  constructor(message = "The wallet request was rejected.") {
    super(message);
    this.name = "WalletRejected";
  }
}

function rpcCode(e: unknown): number | null {
  const c = (e as { code?: unknown })?.code;
  return typeof c === "number" ? c : null;
}

async function req<T>(p: Eip1193Provider, method: string, params?: unknown[]): Promise<T> {
  try {
    return (await p.request(params ? { method, params } : { method })) as T;
  } catch (e) {
    if (rpcCode(e) === 4001) throw new WalletRejected();
    throw e;
  }
}

export async function requestAccount(p: Eip1193Provider): Promise<string> {
  const accounts = await req<string[]>(p, "eth_requestAccounts");
  const a = accounts?.[0];
  if (typeof a !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error("The wallet returned no account.");
  return a;
}

/** Switches the wallet to `caip2` (adds Base/Arbitrum/… when the wallet lacks it); verifies afterwards. */
export async function ensureChain(p: Eip1193Provider, caip2: string): Promise<void> {
  const info = getChain(caip2);
  if (!info?.evmChainId) throw new Error(`Not an EVM chain: ${caip2}`);
  const want = hexChainId(info.evmChainId);
  const current = String(await req<string>(p, "eth_chainId")).toLowerCase();
  if (current === want) return;
  try {
    await req(p, "wallet_switchEthereumChain", [{ chainId: want }]);
  } catch (e) {
    if (rpcCode(e) !== 4902 || !info.evmAdd) throw e;
    await req(p, "wallet_addEthereumChain", [
      {
        chainId: want,
        chainName: info.name,
        nativeCurrency: { name: info.nativeSymbol, symbol: info.nativeSymbol, decimals: info.nativeDecimals },
        rpcUrls: info.evmAdd.rpcUrls,
        blockExplorerUrls: info.evmAdd.blockExplorerUrls,
      },
    ]);
  }
  const after = String(await req<string>(p, "eth_chainId")).toLowerCase();
  if (after !== want) throw new Error(`Switch your wallet to ${info.name} to pay.`);
}

export async function sendTransaction(p: Eip1193Provider, tx: EvmTxRequest): Promise<string> {
  const hash = await req<string>(p, "eth_sendTransaction", [tx]);
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash))
    throw new Error("The wallet returned no transaction hash.");
  return hash;
}

const utf8Hex = (s: string): string =>
  `0x${Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("")}`;

/** ERC-191 `personal_sign` of a UTF-8 string; returns the 65-byte signature hex. */
export async function personalSign(p: Eip1193Provider, message: string, address: string): Promise<string> {
  const sig = await req<string>(p, "personal_sign", [utf8Hex(message), address]);
  if (typeof sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sig))
    throw new Error("The wallet returned no signature.");
  return sig;
}
