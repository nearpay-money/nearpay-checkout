/**
 * Typed client for the public payer routes (`client_secret`) and the sentinel co-signing route, built
 * from the `@nearpay-money/spec` route tables (lld/checkout-and-js.md §3 `src/lib/api`). Requests are checked
 * against the route's request schemas before they leave; responses are parsed with the response
 * schemas, tolerating unknown fields and unknown open-enum values (api-conventions §5).
 *
 * The client secret travels only in the `X-NearPay-Client-Secret` header and the invoice secret only in
 * `X-NearPay-Invoice-Secret` (hosted invoices, Stage 3); neither is ever logged or put in a URL.
 */
import { type AnyRoute, buildPath, HEADERS, type RouteResponse, safeParseTolerant } from "@nearpay-money/spec";
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

/**
 * Parses a response object with the spec's `safeParseTolerant` (spec 0.1.5): unknown values of open
 * enums pass through verbatim (the UI treats them as "unknown"); closed enums, literals, shapes and
 * missing fields fail with `invalid_response`.
 */
export function parseTolerant<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const r = safeParseTolerant(schema, data);
  if (r.success) return r.data;
  throw parseTolerantFailure();
}

export interface CallOptions {
  readonly params?: Record<string, string>;
  readonly query?: Record<string, string | undefined>;
  readonly body?: unknown;
  readonly secret?: string;
  /** Invoice secret from the `/i/:id` fragment, for routes that declare `X-NearPay-Invoice-Secret`. */
  readonly invoiceSecret?: string;
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

const INVOICE_SECRET_HEADER = HEADERS.invoiceSecret.toLowerCase();

/** The route declares the invoice-secret header (hosted invoice payer routes). */
function needsInvoiceSecret(route: AnyRoute): boolean {
  const shape = (route.headers as { shape?: Record<string, unknown> } | undefined)?.shape;
  return shape !== undefined && INVOICE_SECRET_HEADER in shape;
}

async function send(route: AnyRoute, opts: CallOptions, accept: string, doFetch: Fetch): Promise<Response> {
  if (route.body) {
    const ok = route.body.safeParse(opts.body ?? {});
    if (!ok.success) throw new RangeError(`request for ${route.id} does not match the contract`);
  }
  const headers: Record<string, string> = { Accept: accept };
  if (route.auth.includes("client_secret")) {
    if (!opts.secret) throw new RangeError(`${route.id} needs the client secret`);
    headers["X-NearPay-Client-Secret"] = opts.secret;
  }
  if (needsInvoiceSecret(route)) {
    // Checked against the route's own header schema before it leaves: a malformed secret is never sent.
    const h = { [INVOICE_SECRET_HEADER]: opts.invoiceSecret };
    if (!opts.invoiceSecret || !route.headers?.safeParse(h).success) {
      throw new RangeError(`${route.id} needs the invoice secret`);
    }
    headers[HEADERS.invoiceSecret] = opts.invoiceSecret as string;
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
  return res;
}

/**
 * Calls a route with a binary success body (`binaryResponse`, e.g. the invoice PDF). The body must have
 * the declared content type; anything else is `invalid_response`.
 */
export async function callBinary(
  route: AnyRoute,
  opts: CallOptions = {},
  doFetch: Fetch = (...a) => fetch(...a),
): Promise<Blob> {
  const type = route.binaryResponse?.contentType;
  if (!type) throw new RangeError(`${route.id} has no binary response`);
  const res = await send(route, opts, `${type}, application/json`, doFetch);
  const got = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (got !== type) throw parseTolerantFailure();
  const blob = await res.blob().catch(() => {
    throw networkError();
  });
  return blob.type === type ? blob : new Blob([blob], { type });
}

/** Calls a spec route. */
export async function call<R extends AnyRoute>(
  route: R,
  opts: CallOptions = {},
  doFetch: Fetch = (...a) => fetch(...a),
): Promise<RouteResponse<R>> {
  const res = await send(route, opts, "application/json", doFetch);
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
