/**
 * Parent-window bridge of the embedded checkout. Installed before React renders (the loader may send
 * `np:init` as soon as the frame loads), it buffers inbound messages until the session — and with it
 * `allowed_origins` — is known, then accepts `np:init` only per §5.3 and from then on posts every
 * message to that one verified origin.
 */
import { type Appearance, envelope, type InitMessage, initAccepted, type OutboundMessage, parseInit } from "./protocol";

interface Pending {
  readonly origin: string;
  readonly fromParent: boolean;
  readonly init: InitMessage;
}

export interface Bridge {
  /** Resolves with the verified parent origin and init payload, or "rejected". */
  verify(allowed: readonly string[]): Promise<{ origin: string; init: InitMessage } | "rejected">;
  post(m: OutboundMessage): void;
  readonly framed: boolean;
}

export function installBridge(win: Window, timeoutMs = 10_000): Bridge {
  const framed = win.parent !== win;
  const pending: Pending[] = [];
  let waiter: ((p: Pending) => void) | null = null;
  let parentOrigin: string | null = null;

  win.addEventListener("message", (ev: MessageEvent) => {
    const init = parseInit(ev.data);
    if (!init) return;
    const p: Pending = { origin: ev.origin, fromParent: ev.source === win.parent, init };
    if (waiter) waiter(p);
    else pending.push(p);
  });

  const ancestor = (): string | null => {
    const list = (win.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
    return list && list.length > 0 ? (list[0] ?? null) : null;
  };

  return {
    framed,
    verify(allowed) {
      if (!framed) return Promise.resolve("rejected");
      return new Promise((resolve) => {
        const check = (p: Pending): boolean => {
          if (!initAccepted({ origin: p.origin, fromParent: p.fromParent }, allowed, ancestor())) {
            // The parent itself is not an allowed site → blocked at once (never answered).
            // Messages from any other window are ignored.
            if (!p.fromParent) return false;
            waiter = null;
            clearTimeout(timer);
            resolve("rejected");
            return true;
          }
          parentOrigin = p.origin;
          waiter = null;
          clearTimeout(timer);
          resolve({ origin: p.origin, init: p.init });
          return true;
        };
        const timer = setTimeout(() => {
          waiter = null;
          resolve("rejected");
        }, timeoutMs);
        for (const p of pending.splice(0)) if (check(p)) return;
        waiter = (p) => {
          check(p);
        };
      });
    },
    post(m) {
      if (parentOrigin) win.parent.postMessage(envelope(m), parentOrigin);
    },
  };
}

/** Applies the merchant's appearance through CSS custom properties (CSSOM; allowed by the CSP). */
export function applyAppearance(root: HTMLElement, a: Appearance): void {
  if (a.theme !== "auto") root.dataset.theme = a.theme;
  if (a.accent) root.style.setProperty("--np-accent", a.accent);
  if (a.radius !== null) root.style.setProperty("--np-radius", `${a.radius}px`);
}
