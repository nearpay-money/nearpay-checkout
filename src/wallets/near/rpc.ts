/**
 * Read-only NEAR JSON-RPC calls of the wallet path (configured `VITE_NEAR_RPC_URL`, already in the CSP):
 * storage registration and the Verifier salt. Balance and gas-price reads are in `balances.ts`.
 */
export type FetchLike = typeof fetch;

export async function nearRpc<T>(rpcUrl: string, method: string, params: unknown, doFetch: FetchLike): Promise<T> {
  const res = await doFetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "omit",
    referrerPolicy: "no-referrer",
    body: JSON.stringify({ jsonrpc: "2.0", id: "np", method, params }),
  });
  if (!res.ok) throw new Error(`NEAR RPC ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: unknown };
  if (body.error || body.result === undefined || body.result === null) throw new Error(`NEAR RPC ${method} failed`);
  return body.result;
}

export async function viewFunction<T>(
  rpcUrl: string,
  contract: string,
  method: string,
  args: object,
  doFetch: FetchLike = (...a) => fetch(...a),
): Promise<T> {
  const argsBase64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(args))));
  const result = await nearRpc<{ result?: number[] }>(
    rpcUrl,
    "query",
    {
      request_type: "call_function",
      finality: "final",
      account_id: contract,
      method_name: method,
      args_base64: argsBase64,
    },
    doFetch,
  );
  if (!Array.isArray(result.result)) throw new Error("NEAR RPC view call failed");
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result))) as T;
}

export interface StorageBalance {
  readonly total: string;
  readonly available: string;
}

export const storageBalanceOf = (rpc: string, token: string, account: string, f?: FetchLike) =>
  viewFunction<StorageBalance | null>(rpc, token, "storage_balance_of", { account_id: account }, f);

export const storageBalanceBounds = (rpc: string, token: string, f?: FetchLike) =>
  viewFunction<{ min: string; max: string | null }>(rpc, token, "storage_balance_bounds", {}, f);

/** `current_salt` of the Verifier (4 bytes, lower-case hex). */
export async function currentSalt(rpc: string, contract: string, f?: FetchLike): Promise<string> {
  const salt = await viewFunction<string>(rpc, contract, "current_salt", {}, f);
  if (typeof salt !== "string" || !/^[0-9a-f]{8}$/.test(salt)) throw new Error("unexpected current_salt");
  return salt;
}
