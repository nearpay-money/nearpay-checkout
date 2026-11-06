/**
 * Typed client for the public payer routes (`client_secret`) and the sentinel co-signing route, built
 * from the `@nearpay/spec` route tables (lld/checkout-and-js.md §3 `src/lib/api`). Requests are checked
 * against the route's request schemas before they leave; responses are parsed with the response
 * schemas, tolerating unknown fields and unknown open-enum values (api-conventions §5).
 *
 * The client secret travels only in the `X-NearPay-Client-Secret` header and is never logged.
 */
import { type AnyRoute, buildPath, type RouteResponse } from "@nearpay/spec";
import type { z } from "zod";
import { config } from "../../config";

export interface ApiErrorShape {
  readonly status: number;
  readonly code: string;
  readonly type: string;
  readonly message: string;
  readonly param: string | null;
  readonly retryAfterS: number | null;
}

export class ApiError extends Error implements ApiErrorShape {
  readonly status: number;
  readonly code: string;
  readonly type: string;
  readonly param: string | null;
  readonly retryAfterS: number | null;
  constructor(e: ApiErrorShape) {
    super(e.message);
    this.name = "ApiError";
    this.status = e.status;
    this.code = e.code;
    this.type = e.type;
    this.param = e.param;
    this.retryAfterS = e.retryAfterS;
  }
}

export function isApiError(e: unknown, code?: string): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code);
}

/** Parses a response object; unknown open-enum values pass through (UI treats them as "unknown"). */
export function parseTolerant<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  if (r.error.issues.length > 0 && r.error.issues.every((i) => i.code === "invalid_value" && i.values.length > 1)) {
    return data as z.output<S>;
  }
  throw new ApiError({
    status: 0,
    code: "invalid_response",
    type: "api_error",
    message: "The server sent a response this page does not understand.",
    param: null,
    retryAfterS: null,
  });
}

export interface CallOptions {
  readonly params?: Record<string, string>;
  readonly query?: Record<string, string | undefined>;
  readonly body?: unknown;
  readonly secret?: string;
  readonly signal?: AbortSignal;
  /** Return the raw JSON body without schema parsing (sentinel: verified byte-for-byte later). */
  readonly raw?: boolean;
}

export type Fetch = typeof fetch;

export function routeUrl(route: AnyRoute, params: Record<string, string> = {}, query?: CallOptions["query"]): string {
  let url = `${config.apiOrigin}${buildPath(route, params)}`;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") qs.set(k, v);
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  return url;
}

async function errorFrom(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const e = (body as { error?: Record<string, unknown> } | null)?.error ?? {};
  const retry = Number(res.headers.get("retry-after"));
  return new ApiError({
    status: res.status,
    code: typeof e.code === "string" ? e.code : res.status >= 500 ? "api_error" : "invalid_request",
    type: typeof e.type === "string" ? e.type : "api_error",
    message: typeof e.message === "string" ? e.message : `Request failed (${res.status}).`,
    param: typeof e.param === "string" ? e.param : null,
    retryAfterS: Number.isFinite(retry) && retry > 0 ? retry : null,
  });
}

export function networkError(): ApiError {
  return new ApiError({
    status: 0,
    code: "network_error",
    type: "api_error",
    message: "Could not reach NearPay. Check your connection and try again.",
    param: null,
    retryAfterS: null,
  });
}

/** Calls a spec route. */
export async function call<R extends AnyRoute>(
  route: R,
  opts: CallOptions = {},
  doFetch: Fetch = (...a) => fetch(...a),
): Promise<RouteResponse<R>> {
  if (route.body) {
    const ok = route.body.safeParse(opts.body ?? {});
    if (!ok.success) throw new RangeError(`request for ${route.id} does not match the contract`);
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (route.auth.includes("client_secret")) {
    if (!opts.secret) throw new RangeError(`${route.id} needs the client secret`);
    headers["X-NearPay-Client-Secret"] = opts.secret;
  }
  if (route.method !== "GET") headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await doFetch(routeUrl(route, opts.params, opts.query), {
      method: route.method,
      headers,
      body: route.method === "GET" ? null : JSON.stringify(opts.body ?? {}),
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") throw e;
    throw networkError();
  }
  if (res.status !== route.status) throw await errorFrom(res);
  if (route.response === null) return undefined as RouteResponse<R>;
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw parseTolerantFailure();
  }
  if (opts.raw) return json as RouteResponse<R>;
  return parseTolerant(route.response, json) as RouteResponse<R>;
}

function parseTolerantFailure(): ApiError {
  return new ApiError({
    status: 0,
    code: "invalid_response",
    type: "api_error",
    message: "The server sent a response this page does not understand.",
    param: null,
    retryAfterS: null,
  });
}
