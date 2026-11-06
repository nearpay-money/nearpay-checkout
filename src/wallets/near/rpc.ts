/** Read-only NEAR JSON-RPC view calls the wallet path needs (storage registration, Verifier salt). */
export type FetchLike = typeof fetch;

export async function viewFunction<T>(
  rpcUrl: string,
  contract: string,
  method: string,
  args: object,
  doFetch: FetchLike = (...a) => fetch(...a),
): Promise<T> {
  const argsBase64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(args))));
  const res = await doFetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "omit",
    referrerPolicy: "no-referrer",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "np",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contract,
        method_name: method,
        args_base64: argsBase64,
      },
    }),
  });
  if (!res.ok) throw new Error(`NEAR RPC ${res.status}`);
  const body = (await res.json()) as { result?: { result?: number[] }; error?: unknown };
  if (body.error || !Array.isArray(body.result?.result)) throw new Error("NEAR RPC view call failed");
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(body.result.result))) as T;
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
