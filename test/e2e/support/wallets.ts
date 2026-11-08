/** Injected test wallets: an EIP-6963 EVM provider and the e2e build's NEAR wallet hook. */
import type { Page } from "@playwright/test";

export async function injectEvmWallet(
  page: Page,
  opts: { chainId?: string; reject?: boolean; sendError?: "reject" | "insufficient" | "hang" | null } = {},
): Promise<void> {
  await page.addInitScript(
    ({ chainId, reject, sendError }) => {
      const w = window as unknown as Record<string, unknown>;
      const calls: { method: string; params?: unknown }[] = [];
      w.__evmCalls = calls;
      let chain = chainId;
      const provider = {
        async request({ method, params }: { method: string; params?: unknown[] }) {
          calls.push({ method, params });
          switch (method) {
            case "eth_requestAccounts":
              if (reject) throw Object.assign(new Error("User rejected"), { code: 4001 });
              return ["0x42E06263bb5346ae6421aB1Ec1019824e7B284E1"];
            case "eth_chainId":
              return chain;
            case "wallet_switchEthereumChain":
              chain = (params as { chainId: string }[])[0]?.chainId ?? chain;
              return null;
            case "eth_sendTransaction":
              if (sendError === "hang") return new Promise(() => undefined);
              if (sendError === "reject") throw Object.assign(new Error("User rejected"), { code: 4001 });
              if (sendError === "insufficient")
                throw Object.assign(new Error("insufficient funds for gas * price + value"), { code: -32000 });
              return `0x${"ab".repeat(32)}`;
            case "personal_sign":
              return `0x${"11".repeat(64)}1b`;
            default:
              throw Object.assign(new Error("unsupported"), { code: 4200 });
          }
        },
      };
      const info = {
        uuid: "0b7f0d5e-1111-4c4c-9a9a-000000000001",
        name: "Mock Wallet",
        icon: "data:image/svg+xml;base64,PHN2Zy8+",
        rdns: "test.mockwallet",
      };
      const announce = () =>
        window.dispatchEvent(
          new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }),
        );
      window.addEventListener("eip6963:requestProvider", announce);
      announce();
    },
    { chainId: opts.chainId ?? "0x1", reject: opts.reject ?? false, sendError: opts.sendError ?? null },
  );
}

export async function injectNearWallet(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const calls: { method: string; params: unknown }[] = [];
    w.__nearCalls = calls;
    w.__NP_E2E_NEAR_WALLET__ = {
      accountId: "payer.near",
      label: "Mock NEAR",
      async signAndSendTransactions(txs: unknown) {
        calls.push({ method: "signAndSendTransactions", params: txs });
        return [{ transaction: { hash: "9XKGkKdV8ZP2t5cE6z6V8S1Ud6eS3wQ7t2Fq9KcYQm1e" } }];
      },
      async signMessage(p: { message: string; recipient: string; nonce: Uint8Array }) {
        calls.push({
          method: "signMessage",
          params: { message: p.message, recipient: p.recipient, nonceLength: p.nonce.length },
        });
        return {
          accountId: "payer.near",
          publicKey: "ed25519:2SBdAzviwkHZ4YkAdGqXTitBPqw752YyNhYtzBQiBb25",
          signature: btoa(String.fromCharCode(...new Uint8Array(64).fill(7))),
        };
      },
    };
  });
}

/** NEAR RPC stub: storage not registered, bounds min, Verifier salt. */
export async function stubNearRpc(page: Page, registered = false): Promise<string[]> {
  const methods: string[] = [];
  await page.route("https://free.rpc.fastnear.com/**", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { params: { method_name: string } };
    methods.push(body.params.method_name);
    const value =
      body.params.method_name === "storage_balance_of"
        ? registered
          ? { total: "1", available: "0" }
          : null
        : body.params.method_name === "storage_balance_bounds"
          ? { min: "1250000000000000000000", max: null }
          : "252812b3";
    const result = Array.from(Buffer.from(JSON.stringify(value)));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: "np", result: { result } }),
    });
  });
  return methods;
}

/** Solana payer of the spec vector (solana-transfer.json). */
export const SOL_PAYER = "EyjEeiTxb4rvkoN3ZA2zTimuc6VyF8V1QuH9TT66Gkn6";

/**
 * A Wallet Standard Solana wallet ("Mock Phantom") registered through the standard window events, as
 * real extensions do. Records the transactions it is asked to sign and send (`__solCalls`).
 */
export async function injectSolanaWallet(
  page: Page,
  opts: { reject?: "connect" | "send" | null; sendError?: string | null } = {},
): Promise<void> {
  await page.addInitScript(
    ({ payer, reject, sendError }) => {
      const w = window as unknown as Record<string, unknown>;
      const calls: { method: string; tx?: number[]; chain?: string }[] = [];
      w.__solCalls = calls;
      const account = {
        address: payer,
        publicKey: new Uint8Array(32),
        chains: ["solana:mainnet"],
        features: ["solana:signAndSendTransaction"],
      };
      const wallet = {
        version: "1.0.0",
        name: "Mock Phantom",
        icon: "data:image/svg+xml;base64,PHN2Zy8+",
        chains: ["solana:mainnet", "solana:devnet"],
        accounts: [] as unknown[],
        features: {
          "standard:connect": {
            version: "1.0.0",
            async connect() {
              calls.push({ method: "connect" });
              if (reject === "connect") throw Object.assign(new Error("User rejected the request."), { code: 4001 });
              return { accounts: [account] };
            },
          },
          "standard:events": { version: "1.0.0", on: () => () => undefined },
          "solana:signAndSendTransaction": {
            version: "1.0.0",
            supportedTransactionVersions: ["legacy", 0],
            async signAndSendTransaction(...inputs: { transaction: Uint8Array; chain: string }[]) {
              const i = inputs[0] as { transaction: Uint8Array; chain: string };
              calls.push({ method: "signAndSendTransaction", tx: Array.from(i.transaction), chain: i.chain });
              if (reject === "send") throw Object.assign(new Error("User rejected the request."), { code: 4001 });
              if (sendError) throw new Error(sendError);
              return [{ signature: new Uint8Array(64).fill(7) }];
            },
          },
        },
      };
      const callback = ({ register }: { register: (w: unknown) => void }) => register(wallet);
      window.addEventListener("wallet-standard:app-ready", (e) =>
        callback((e as CustomEvent<{ register: (w: unknown) => void }>).detail),
      );
      window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: callback }));
    },
    { payer: SOL_PAYER, reject: opts.reject ?? null, sendError: opts.sendError ?? null },
  );
}

/** Solana RPC stub: blockhash, mint owner (classic Token unless `token2022`), deposit ATA missing, rent. */
export async function stubSolanaRpc(page: Page, opts: { token2022?: boolean; down?: boolean } = {}): Promise<string[]> {
  const methods: string[] = [];
  await page.route("https://api.mainnet-beta.solana.com/**", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { method: string; params: unknown[] };
    methods.push(body.method);
    if (opts.down) return route.fulfill({ status: 503, body: "down" });
    const result =
      body.method === "getLatestBlockhash"
        ? { context: { slot: 1 }, value: { blockhash: "AX2DPY1mMojpmUNuoYycmtqmkRQ9hX8sgYKKiWUvCHZv", lastValidBlockHeight: 10 } }
        : body.method === "getMinimumBalanceForRentExemption"
          ? 2039280
          : body.method === "getAccountInfo"
            ? {
                context: { slot: 1 },
                value:
                  body.params[0] === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
                    ? {
                        owner: opts.token2022
                          ? "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
                          : "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                        lamports: 1,
                        data: ["", "base64"],
                        executable: false,
                      }
                    : null,
              }
            : null;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: 1, result }) });
  });
  return methods;
}
