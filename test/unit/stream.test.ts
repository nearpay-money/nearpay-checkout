import { getPublicCheckoutSession, PublicCheckoutSession, submitDepositTx } from "@nearpay/spec";
import { describe, expect, it, vi } from "vitest";
import { SseParser } from "../../src/features/status-stream/sse";
import { decodeStreamEvent, openStatusStream, type StreamMessage } from "../../src/features/status-stream/stream";
import { ApiError, call, isApiError, parseTolerant, routeUrl } from "../../src/lib/api/client";
import { attempt, SECRET, SESSION_ID, session } from "../support/sessions";

describe("SSE parser", () => {
  it("parses events across chunk boundaries, comments, ids and retry", () => {
    const p = new SseParser();
    expect(p.feed(": heartbeat\n\nretry: 3000\nevent: session\nda")).toEqual([]);
    expect(p.feed('ta: {"a":1}\nid: 7\n\r')).toEqual([]);
    expect(p.feed("\nevent: x\ndata\ndata:  two\r\n\r\ndata:plain\n\n")).toEqual([
      { event: "session", data: '{"a":1}', id: "7" },
      { event: "x", data: "\n two", id: "7" },
      { event: "message", data: "plain", id: "7" },
    ]);
    expect(p.retryMs).toBe(3000);
    expect(p.feed("retry: soon\nid: a\0b\nevent: y\n\n")).toEqual([]);
    expect(p.retryMs).toBe(3000);
    expect(p.feed("unknown: 1\ndata: z\n\n")).toEqual([{ event: "message", data: "z", id: "7" }]);
  });
});

describe("stream event decoding", () => {
  it("decodes the three event kinds with the spec schemas", () => {
    expect(decodeStreamEvent("session", JSON.stringify(session()))?.kind).toBe("session");
    expect(decodeStreamEvent("attempt", JSON.stringify(attempt()))?.kind).toBe("attempt");
    expect(
      decodeStreamEvent(
        "intent",
        JSON.stringify({ id: "pi_01jbz9k3m4n5p6q7r8s9t0v1w2", status: "processing", amount_settled: "0", late: false }),
      )?.kind,
    ).toBe("intent");
    expect(decodeStreamEvent("other", "{}")).toBeNull();
    expect(decodeStreamEvent("session", "not json")).toBeNull();
    expect(decodeStreamEvent("attempt", "{}")).toBeNull();
  });
  it("tolerates unknown open-enum values", () => {
    const m = decodeStreamEvent("attempt", JSON.stringify(attempt({ status: "brand_new" as never })));
    expect(m?.kind === "attempt" && m.attempt.status).toBe("brand_new");
  });
});

function sseResponse(body: string, status = 200) {
  return new Response(new Blob([body]).stream(), { status, headers: { "content-type": "text/event-stream" } });
}

describe("status stream", () => {
  it("delivers SSE messages and reconnects with the server's retry", async () => {
    const got: StreamMessage[] = [];
    const timers: [() => void, number][] = [];
    const doFetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`/api/v1/checkout/sessions/${SESSION_ID}/public/stream`);
      expect((init.headers as Record<string, string>)["X-NearPay-Client-Secret"]).toBe(SECRET);
      return sseResponse(
        `retry: 1500\nevent: session\ndata: ${JSON.stringify(session())}\n\nevent: attempt\ndata: ${JSON.stringify(attempt())}\n\n`,
      );
    });
    const modes: string[] = [];
    const stop = openStatusStream(
      {
        sessionId: SESSION_ID,
        secret: SECRET,
        fetch: doFetch as unknown as typeof fetch,
        setTimer: (fn, ms) => timers.push([fn, ms]),
        clearTimer: () => undefined,
      },
      { onMessage: (m) => got.push(m), onMode: (m) => modes.push(m) },
    );
    await vi.waitFor(() => expect(timers.length).toBe(1));
    expect(got.map((m) => m.kind)).toEqual(["session", "attempt"]);
    expect(timers[0]?.[1]).toBe(1500);
    expect(modes).toEqual(["sse"]);
    stop();
  });

  it("falls back to polling when the stream is unavailable", async () => {
    const got: StreamMessage[] = [];
    const timers: [() => void, number][] = [];
    const doFetch = vi.fn(async (url: string) => {
      if (url.endsWith("/stream")) return new Response("nope", { status: 503 });
      return new Response(JSON.stringify(session({ intent_status: "processing" })), { status: 200 });
    });
    const errors: unknown[] = [];
    const stop = openStatusStream(
      {
        sessionId: SESSION_ID,
        secret: SECRET,
        fetch: doFetch as unknown as typeof fetch,
        setTimer: (fn, ms) => timers.push([fn, ms]),
        clearTimer: () => undefined,
        pollMs: 3000,
      },
      { onMessage: (m) => got.push(m), onError: (e) => errors.push(e) },
    );
    await vi.waitFor(() => expect(timers.length).toBe(2));
    expect(timers.map((t) => t[1])).toEqual([0, 3000]);
    timers[0]?.[0]();
    await vi.waitFor(() => expect(got.length).toBe(1));
    expect(got[0]?.kind).toBe("session");
    expect(errors.length).toBe(1);
    stop();
  });

  it("stops on an invalid client secret", async () => {
    const errors: unknown[] = [];
    const timers: unknown[] = [];
    openStatusStream(
      {
        sessionId: SESSION_ID,
        secret: SECRET,
        fetch: (async () => new Response("", { status: 401 })) as unknown as typeof fetch,
        setTimer: (fn) => timers.push(fn),
        clearTimer: () => undefined,
      },
      { onMessage: () => undefined, onError: (e) => errors.push(e) },
    );
    await vi.waitFor(() => expect(errors.length).toBe(1));
    expect(timers).toEqual([]);
  });

  it("reports network errors and stops cleanly", async () => {
    const errors: unknown[] = [];
    const stop = openStatusStream(
      {
        sessionId: SESSION_ID,
        secret: SECRET,
        fetch: (async () => {
          throw new TypeError("offline");
        }) as unknown as typeof fetch,
        setTimer: () => 1,
        clearTimer: () => undefined,
      },
      { onMessage: () => undefined, onError: (e) => errors.push(e) },
    );
    await vi.waitFor(() => expect(errors.length).toBe(1));
    stop();
  });
});

describe("API client", () => {
  it("sends the client secret header and parses responses", async () => {
    const doFetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)["X-NearPay-Client-Secret"]).toBe(SECRET);
      expect(init.credentials).toBe("omit");
      return new Response(JSON.stringify(session()), { status: 200 });
    });
    const s = await call(
      getPublicCheckoutSession,
      { params: { id: SESSION_ID }, secret: SECRET },
      doFetch as unknown as typeof fetch,
    );
    expect(s.id).toBe(SESSION_ID);
    await expect(
      call(getPublicCheckoutSession, { params: { id: SESSION_ID } }, doFetch as unknown as typeof fetch),
    ).rejects.toThrow(/client secret/);
  });

  it("checks request bodies against the contract", async () => {
    await expect(
      call(
        submitDepositTx,
        { params: { id: SESSION_ID, attempt: attempt().id }, body: { tx_hash: "x" }, secret: SECRET },
        vi.fn(),
      ),
    ).rejects.toThrow(/contract/);
    const ok = vi.fn(async () => new Response(null, { status: 202 }));
    expect(
      await call(
        submitDepositTx,
        { params: { id: SESSION_ID, attempt: attempt().id }, body: { tx_hash: `0x${"a".repeat(64)}` }, secret: SECRET },
        ok as unknown as typeof fetch,
      ),
    ).toBeUndefined();
  });

  it("maps error envelopes, network failures and junk", async () => {
    const env = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { type: "invalid_request_error", code: "client_secret_invalid", message: "no", param: "x" },
          }),
          { status: 401, headers: { "retry-after": "2" } },
        ),
    );
    const e = await call(
      getPublicCheckoutSession,
      { params: { id: SESSION_ID }, secret: SECRET },
      env as unknown as typeof fetch,
    ).catch((x) => x);
    expect(isApiError(e, "client_secret_invalid")).toBe(true);
    expect(e).toMatchObject({ status: 401, param: "x", retryAfterS: 2 });
    const html = vi.fn(async () => new Response("<html>", { status: 502 }));
    expect(
      await call(
        getPublicCheckoutSession,
        { params: { id: SESSION_ID }, secret: SECRET },
        html as unknown as typeof fetch,
      ).catch((x) => x.code),
    ).toBe("api_error");
    const html400 = vi.fn(async () => new Response("<html>", { status: 400 }));
    expect(
      await call(
        getPublicCheckoutSession,
        { params: { id: SESSION_ID }, secret: SECRET },
        html400 as unknown as typeof fetch,
      ).catch((x) => x.code),
    ).toBe("invalid_request");
    const down = vi.fn(async () => {
      throw new TypeError("fail");
    });
    expect(
      await call(
        getPublicCheckoutSession,
        { params: { id: SESSION_ID }, secret: SECRET },
        down as unknown as typeof fetch,
      ).catch((x) => x.code),
    ).toBe("network_error");
    const abort = vi.fn(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    expect(
      await call(
        getPublicCheckoutSession,
        { params: { id: SESSION_ID }, secret: SECRET },
        abort as unknown as typeof fetch,
      ).catch((x) => x.name),
    ).toBe("AbortError");
    const junk = vi.fn(async () => new Response("{", { status: 200 }));
    expect(
      await call(
        getPublicCheckoutSession,
        { params: { id: SESSION_ID }, secret: SECRET },
        junk as unknown as typeof fetch,
      ).catch((x) => x.code),
    ).toBe("invalid_response");
    const wrong = vi.fn(async () => new Response(JSON.stringify({ id: 1 }), { status: 200 }));
    expect(
      await call(
        getPublicCheckoutSession,
        { params: { id: SESSION_ID }, secret: SECRET },
        wrong as unknown as typeof fetch,
      ).catch((x) => x.code),
    ).toBe("invalid_response");
    const raw = vi.fn(async () => new Response(JSON.stringify({ any: 1 }), { status: 200 }));
    expect(
      await call(
        getPublicCheckoutSession,
        { params: { id: SESSION_ID }, secret: SECRET, raw: true },
        raw as unknown as typeof fetch,
      ),
    ).toEqual({ any: 1 });
  });

  it("builds URLs with query strings", () => {
    expect(routeUrl(getPublicCheckoutSession, { id: SESSION_ID }, { a: "1", b: undefined, c: "" })).toBe(
      `/api/v1/checkout/sessions/${SESSION_ID}/public?a=1`,
    );
    expect(routeUrl(getPublicCheckoutSession, { id: SESSION_ID }, {})).toBe(
      `/api/v1/checkout/sessions/${SESSION_ID}/public`,
    );
  });

  it("parseTolerant accepts unknown enum values only", () => {
    expect(parseTolerant(PublicCheckoutSession, session({ status: "paused" as never })).status).toBe("paused");
    expect(() => parseTolerant(PublicCheckoutSession, { ...session(), object: "x" })).toThrow(ApiError);
  });
});
