/**
 * Mock NearPay for the checkout's Playwright tests: serves `dist-e2e/` (SPA fallback) and the public
 * payer routes + sentinel co-signing under `/api`, driven by the `@nearpay/spec` route tables. Every
 * request body is validated with the route's request schema and every response/event with its response
 * schema, so the tests double as contract tests of the checkout's API usage. Attestations are signed with
 * the spec's test-vector sentinel key (pinned by the e2e build).
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import {
  type AnyRoute,
  createDepositInstructionsAttestation,
  createPaymentAttempt,
  getPublicCheckoutSession,
  IntentStreamEvent,
  listPaymentOptions,
  PayerAttempt,
  PublicCheckoutSession,
  pathMatcher,
  signalDepositSent,
  simulateDeposit,
  streamCheckoutSession,
  submitDepositTx,
  submitSignedIntent,
} from "@nearpay/spec";
import { ed25519 } from "@noble/curves/ed25519.js";
import canonicalize from "canonicalize";
import { SEED, sentinelVectors } from "../../support/fixtures";
import {
  type Attempt,
  attempt as attemptFixture,
  type Intent,
  type Session,
  session as sessionFixture,
  USDC_BASE,
  USDC_NEAR,
} from "../../support/sessions";

export type SentinelMode =
  | "ok"
  | "tamper_address"
  | "tamper_amount"
  | "rogue_key"
  | "unknown_kid"
  | "wrong_attempt"
  | "refused"
  | "stale"
  | "unavailable";

export interface MockSession {
  session: Session;
  secret: string;
  options: unknown[];
  attempts: Attempt[];
  intentId: string;
  sentinel: SentinelMode;
  /** Attempt deadline offset from now, seconds. */
  deadlineS: number;
  /** Error code returned by the next createPaymentAttempt call. */
  attemptError: string | null;
  streamDown: boolean;
  /** Advance automatically after a deposit signal (simulate / tx / signed intent). */
  autoSucceed: boolean;
  memo: string | null;
  streams: Set<ServerResponse>;
}

export interface Call {
  route: string;
  body: unknown;
  headers: IncomingMessage["headers"];
}

const ROUTES: AnyRoute[] = [
  getPublicCheckoutSession,
  listPaymentOptions,
  createPaymentAttempt,
  submitDepositTx,
  signalDepositSent,
  submitSignedIntent,
  streamCheckoutSession,
  simulateDeposit,
  createDepositInstructionsAttestation,
];

const ERRORS: Record<string, [number, string]> = {
  client_secret_invalid: [401, "authentication_error"],
  route_too_slow: [422, "invalid_request_error"],
  geo_blocked: [403, "permission_error"],
  attempt_in_flight: [409, "state_conflict"],
  rail_unavailable: [503, "api_error"],
  attestation_refused: [409, "state_conflict"],
  attestation_stale: [409, "state_conflict"],
  attestation_unavailable: [503, "api_error"],
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

let seq = 0;
const nextId = <P extends string>(prefix: P): `${P}_${string}` => {
  seq++;
  return `${prefix}_01jbz9k3m4n5p6q7r8s9t${String(seq).padStart(5, "0")}`.slice(
    0,
    prefix.length + 27,
  ) as `${P}_${string}`;
};

export function defaultOptions() {
  const o = (
    method: string,
    asset: string,
    chain: string,
    symbol: string,
    decimals: number,
    amount: string,
    extra: object = {},
  ) => ({
    method,
    origin_asset_id: asset,
    chain,
    symbol,
    decimals,
    estimated_amount_in: amount,
    route_class: method === "intents_transfer" ? "intents_transfer" : "stable_pair",
    min_deadline_s: 300,
    available: true,
    reason: null,
    ...extra,
  });
  return [
    o("route_quote", USDC_BASE, "eip155:8453", "USDC", 6, "2005013"),
    o("route_quote", USDC_NEAR, "near:mainnet", "USDC", 6, "2003000"),
    o("intents_transfer", USDC_NEAR, "near:mainnet", "USDC", 6, "2006000"),
    o("route_quote", "nep141:eth.omft.near", "eip155:1", "ETH", 18, "600000000000000", {
      available: false,
      reason: "route_too_slow",
    }),
  ];
}

function send(res: ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

function apiError(res: ServerResponse, code: string) {
  const [status, type] = ERRORS[code] ?? [400, "invalid_request_error"];
  send(res, status, { error: { type, code, message: `mock ${code}`, request_id: "req_mock" } });
}

function check<T>(schema: { safeParse(v: unknown): { success: boolean; error?: unknown } }, value: T, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new Error(`mock produced an invalid ${what}: ${JSON.stringify(r.error)}`);
  return value;
}

export class MockNearPay {
  readonly sessions = new Map<string, MockSession>();
  readonly calls: Call[] = [];
  private server: Server | null = null;
  port = 0;

  constructor(private readonly root: string) {}

  get origin() {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        console.error(e);
        if (!res.headersSent) send(res, 500, { error: { type: "api_error", code: "api_error", message: String(e) } });
      });
    });
    await new Promise<void>((r) => this.server?.listen(0, "127.0.0.1", r));
    const a = this.server.address();
    this.port = typeof a === "object" && a ? a.port : 0;
  }

  async stop(): Promise<void> {
    for (const s of this.sessions.values()) for (const r of s.streams) r.end();
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  reset(): void {
    for (const s of this.sessions.values()) for (const r of s.streams) r.end();
    this.sessions.clear();
    this.calls.length = 0;
  }

  create(over: Partial<Session> = {}, opts: Partial<Omit<MockSession, "session">> = {}): MockSession {
    const id = nextId("cs");
    const secret = `${id}_secret_${"Zq9".repeat(10)}Ab`;
    const intentId = opts.intentId ?? nextId("pi");
    const s: MockSession = {
      session: { ...sessionFixture(), id, payment_intent: intentId as `pi_${string}`, ...over },
      secret,
      options: defaultOptions(),
      attempts: [],
      intentId,
      sentinel: "ok",
      deadlineS: 900,
      attemptError: null,
      streamDown: false,
      autoSucceed: false,
      memo: null,
      streams: new Set(),
      ...opts,
    };
    check(PublicCheckoutSession, s.session, "session");
    this.sessions.set(id, s);
    return s;
  }

  url(s: MockSession, mode: "c" | "embed" = "c"): string {
    return `${this.origin}/${mode}/${s.session.id}#${s.secret}`;
  }

  /** Pushes an SSE event to every open stream of the session. */
  push(s: MockSession, event: "session" | "attempt" | "intent", data: unknown): void {
    const schema = event === "session" ? PublicCheckoutSession : event === "attempt" ? PayerAttempt : IntentStreamEvent;
    check(schema, data, `${event} event`);
    for (const r of s.streams) r.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  current(s: MockSession): Attempt | undefined {
    return s.attempts.at(-1);
  }

  /** Moves the current attempt (and the intent/session) and pushes the change. */
  setAttempt(s: MockSession, patch: Partial<Attempt>): Attempt {
    const a = this.current(s);
    if (!a) throw new Error("no attempt");
    Object.assign(a, patch);
    s.session.attempt = a;
    this.push(s, "attempt", a);
    return a;
  }

  setIntent(s: MockSession, status: Intent["status"], amount = "2000000"): void {
    s.session.intent_status = status;
    if (status === "succeeded") s.session.status = "complete";
    this.push(s, "intent", {
      id: s.intentId,
      status,
      amount_settled: status === "succeeded" ? amount : "0",
      late: false,
    });
  }

  succeed(s: MockSession): void {
    this.setAttempt(s, { status: "succeeded", attestation_ticket: null });
    this.setIntent(s, "succeeded");
  }

  /** Body of the n-th call to a route (throws when there is none). */
  bodyOf<T = Record<string, string>>(route: string, n = 0): T {
    const c = this.callsTo(route)[n];
    if (!c) throw new Error(`no call ${n} to ${route}`);
    return c.body as T;
  }

  callsTo(route: string): Call[] {
    return this.calls.filter((c) => c.route === route);
  }

  private async body(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.origin);
    if (url.pathname.startsWith("/api/")) return this.api(req, res, url);
    return this.static(url.pathname, res);
  }

  private static(pathname: string, res: ServerResponse) {
    const file = normalize(join(this.root, pathname));
    const target =
      file.startsWith(this.root) && existsSync(file) && statSync(file).isFile() ? file : join(this.root, "index.html");
    res.writeHead(200, { "content-type": MIME[extname(target)] ?? "application/octet-stream" });
    createReadStream(target).pipe(res);
  }

  private async api(req: IncomingMessage, res: ServerResponse, url: URL) {
    const path = url.pathname.slice(4);
    const route = ROUTES.find((r) => r.method === req.method && pathMatcher(r.path).test(path));
    if (!route) return apiError(res, "resource_missing");
    const body = req.method === "POST" ? await this.body(req) : undefined;
    this.calls.push({ route: route.id, body, headers: req.headers });
    if (route.body) check(route.body, body ?? {}, `request body for ${route.id}`);
    if (route.query) check(route.query, Object.fromEntries(url.searchParams), `query for ${route.id}`);

    if (route === createDepositInstructionsAttestation) return this.attest(res, body as Record<string, unknown>);

    const id = path.split("/")[4] as string;
    const s = this.sessions.get(id);
    if (!s || req.headers["x-nearpay-client-secret"] !== s.secret) return apiError(res, "client_secret_invalid");

    switch (route) {
      case getPublicCheckoutSession:
        return send(res, 200, check(PublicCheckoutSession, s.session, "session"));
      case listPaymentOptions: {
        const chain = url.searchParams.get("chain");
        const options = chain ? s.options.filter((o) => (o as { chain: string }).chain === chain) : s.options;
        return send(res, 200, check(listPaymentOptions.response, { object: "payment_options", options }, "options"));
      }
      case streamCheckoutSession: {
        if (s.streamDown) return send(res, 503, { error: { type: "api_error", code: "api_error", message: "down" } });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        res.write(`retry: 3000\nevent: session\ndata: ${JSON.stringify(s.session)}\n\n`);
        s.streams.add(res);
        req.on("close", () => s.streams.delete(res));
        return;
      }
      case createPaymentAttempt:
        return this.createAttempt(s, res, body as Record<string, string>);
      case submitDepositTx:
      case signalDepositSent:
      case simulateDeposit:
      case submitSignedIntent: {
        send(res, 202);
        if (s.autoSucceed) {
          setTimeout(() => this.setAttempt(s, { status: "deposit_detected", attestation_ticket: null }), 150);
          setTimeout(() => this.succeed(s), 400);
        }
        return;
      }
    }
    return apiError(res, "resource_missing");
  }

  private createAttempt(s: MockSession, res: ServerResponse, body: Record<string, string>) {
    if (s.attemptError) {
      const code = s.attemptError;
      s.attemptError = null;
      return apiError(res, code);
    }
    for (const prev of s.attempts) prev.visible = false;
    const option = s.options.find(
      (o) =>
        (o as { origin_asset_id: string; method: string }).origin_asset_id === body.origin_asset_id &&
        (o as { method: string }).method === body.method,
    ) as { chain: string; estimated_amount_in: string } | undefined;
    const deadline = new Date(Math.floor(Date.now() / 1000) * 1000 + s.deadlineS * 1000).toISOString();
    const base = attemptFixture({
      id: nextId("pa"),
      livemode: s.session.livemode,
      origin_asset_id: body.origin_asset_id as string,
      method: body.method as Attempt["method"],
    });
    let a: Attempt;
    if (body.method === "intents_transfer") {
      a = {
        ...base,
        deposit: null,
        intents_requirement: {
          pay_to: "merchant.near",
          token: body.origin_asset_id as string,
          amount: "2000000",
          fee_to: "treasury.nearpay.near",
          fee_amount: "6000",
          binding: "np1:AQDxa2L6a5d8egVC7YP85UgtUCYp3cUotS6S3EsGcF7h",
          deadline,
        },
      };
    } else {
      const chain = option?.chain ?? "eip155:8453";
      a = {
        ...base,
        deposit: {
          address: chain === "near:mainnet" ? "f".repeat(64) : "0x76b4c56085ed136a8744d52be956396624a730e8",
          memo: s.memo,
          amount_in: option?.estimated_amount_in ?? "2005013",
          min_amount_in: "2000000",
          deadline,
          chain,
          origin_asset_id: body.origin_asset_id as string,
        },
      };
    }
    check(PayerAttempt, a, "attempt");
    s.attempts.push(a);
    s.session.attempt = a;
    send(res, 201, a);
  }

  private attest(res: ServerResponse, body: Record<string, unknown>) {
    const attemptId = body.attempt_id as string;
    const s = [...this.sessions.values()].find((x) => x.attempts.some((a) => a.id === attemptId));
    const a = s?.attempts.find((x) => x.id === attemptId);
    if (!s || !a || body.attestation_ticket !== a.attestation_ticket) return apiError(res, "ticket_invalid");
    if (s.sentinel === "refused") return apiError(res, "attestation_refused");
    if (s.sentinel === "stale") return apiError(res, "attestation_stale");
    if (s.sentinel === "unavailable") return apiError(res, "attestation_unavailable");
    const deadline = (a.deposit?.deadline ?? a.intents_requirement?.deadline) as string;
    const attestation: Record<string, unknown> = {
      v: 1,
      kind: a.method,
      attempt_id: s.sentinel === "wrong_attempt" ? "pa_01jbz9k3m4n5p6q7r8s9t0v1zz" : a.id,
      livemode: a.livemode,
      ...(a.deposit
        ? {
            deposit: {
              address:
                s.sentinel === "tamper_address" ? "0x0000000000000000000000000000000000000bad" : a.deposit.address,
              memo: a.deposit.memo,
              chain: a.deposit.chain,
              origin_asset_id: a.deposit.origin_asset_id,
              amount_in: s.sentinel === "tamper_amount" ? "1" : a.deposit.amount_in,
              deadline: a.deposit.deadline,
            },
          }
        : { requirement: a.intents_requirement }),
      merchant: { name: "Acme GmbH", kyb_verified: true },
      destination: { asset_id: USDC_NEAR, chain: "near:mainnet", fingerprint: "YZMN-R81Z-BR" },
      issued_at: new Date().toISOString(),
      expires_at: deadline,
    };
    const seed = s.sentinel === "rogue_key" ? new Uint8Array(32).fill(9) : SEED;
    const signature = Buffer.from(
      ed25519.sign(new TextEncoder().encode(canonicalize(attestation) as string), seed),
    ).toString("base64url");
    const kid = s.sentinel === "unknown_kid" ? "sent-unknown" : sentinelVectors.key.kid;
    send(
      res,
      200,
      check(createDepositInstructionsAttestation.response, { attestation, kid, signature }, "attestation"),
    );
  }
}
