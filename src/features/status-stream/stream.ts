/**
 * Live status (FR-PAY-06, lld/checkout-and-js.md §3 `status-stream`): a fetch-based SSE client for
 * `streamCheckoutSession` (it must send the client-secret header, which `EventSource` cannot), with
 * reconnects honouring `retry:` and a polling fallback (`GET …/public` every 3 s) while the stream is
 * down. Every payload is parsed with the route's event schemas.
 */
import {
  getPublicCheckoutSession,
  IntentStreamEvent,
  PayerAttempt,
  PublicCheckoutSession,
  streamCheckoutSession,
} from "@nearpay/spec";
import type { z } from "zod";
import { call, type Fetch, parseTolerant, routeUrl } from "../../lib/api/client";
import { SseParser } from "./sse";

export type SessionSnapshot = z.output<typeof PublicCheckoutSession>;
export type AttemptSnapshot = z.output<typeof PayerAttempt>;
export type IntentSnapshot = z.output<typeof IntentStreamEvent>;

export type StreamMessage =
  | { readonly kind: "session"; readonly session: SessionSnapshot }
  | { readonly kind: "attempt"; readonly attempt: AttemptSnapshot }
  | { readonly kind: "intent"; readonly intent: IntentSnapshot };

export interface StreamHandlers {
  onMessage(m: StreamMessage): void;
  onMode?(mode: "sse" | "polling"): void;
  onError?(e: unknown): void;
}

export interface StreamOptions {
  readonly sessionId: string;
  readonly secret: string;
  readonly fetch?: Fetch;
  readonly pollMs?: number;
  /** Consecutive stream failures before falling back to polling between reconnects. */
  readonly failuresBeforePolling?: number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (t: unknown) => void;
}

export function decodeStreamEvent(event: string, data: string): StreamMessage | null {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  try {
    switch (event) {
      case "session":
        return {
          kind: "session",
          session: parseTolerant(
            streamCheckoutSession.stream?.events.session ?? PublicCheckoutSession,
            json,
          ) as SessionSnapshot,
        };
      case "attempt":
        return { kind: "attempt", attempt: parseTolerant(PayerAttempt, json) };
      case "intent":
        return { kind: "intent", intent: parseTolerant(IntentStreamEvent, json) };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Starts the stream; returns a stop function. */
export function openStatusStream(opts: StreamOptions, h: StreamHandlers): () => void {
  const doFetch: Fetch = opts.fetch ?? ((...a) => fetch(...a));
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const pollMs = opts.pollMs ?? 3000;
  const threshold = opts.failuresBeforePolling ?? 1;
  let stopped = false;
  let abort: AbortController | null = null;
  let failures = 0;
  let retryMs = streamCheckoutSession.stream?.retryMs ?? 3000;
  let pollTimer: unknown = null;
  let reconnectTimer: unknown = null;
  let mode: "sse" | "polling" | null = null;

  const setMode = (m: "sse" | "polling") => {
    if (mode !== m) {
      mode = m;
      h.onMode?.(m);
    }
  };

  const poll = async () => {
    pollTimer = null;
    if (stopped || mode !== "polling") return;
    try {
      const session = await call(
        getPublicCheckoutSession,
        { params: { id: opts.sessionId }, secret: opts.secret },
        doFetch,
      );
      if (!stopped) h.onMessage({ kind: "session", session });
    } catch (e) {
      h.onError?.(e);
    }
    if (!stopped && mode === "polling") pollTimer = setTimer(poll, pollMs);
  };

  const startPolling = () => {
    if (mode === "polling") return;
    setMode("polling");
    pollTimer = setTimer(poll, 0);
  };

  const connect = async () => {
    reconnectTimer = null;
    if (stopped) return;
    abort = new AbortController();
    const parser = new SseParser();
    let opened = false;
    try {
      const res = await doFetch(routeUrl(streamCheckoutSession, { id: opts.sessionId }), {
        method: "GET",
        headers: { Accept: "text/event-stream", "X-NearPay-Client-Secret": opts.secret },
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: abort.signal,
      });
      if (res.status === 401) {
        h.onError?.(new Error("client_secret_invalid"));
        stopped = true;
        return;
      }
      if (!res.ok || !res.body || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
        throw new Error(`stream unavailable (${res.status})`);
      }
      opened = true;
      failures = 0;
      if (pollTimer !== null) clearTimer(pollTimer);
      pollTimer = null;
      setMode("sse");
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done || stopped) break;
        for (const ev of parser.feed(value)) {
          const m = decodeStreamEvent(ev.event, ev.data);
          if (m) h.onMessage(m);
        }
        if (parser.retryMs !== null) retryMs = parser.retryMs;
      }
    } catch (e) {
      if (stopped) return;
      h.onError?.(e);
    }
    if (stopped) return;
    if (!opened) failures++;
    if (failures >= threshold || !opened) startPolling();
    reconnectTimer = setTimer(connect, retryMs);
  };

  void connect();
  return () => {
    stopped = true;
    abort?.abort();
    if (pollTimer !== null) clearTimer(pollTimer);
    if (reconnectTimer !== null) clearTimer(reconnectTimer);
  };
}
