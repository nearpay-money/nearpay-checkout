import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NEAR_EXCLUDED_WALLETS,
  NEAR_EXECUTOR_INTEGRITY,
  NEAR_MANIFEST_SOURCE,
  NEAR_SELECTOR_COMMIT,
  PINNED_NEAR_MANIFEST,
} from "../../src/wallets/near/manifest";
import {
  assertPinnedWallet,
  connectPinnedWallet,
  executorIntegrity,
  installExecutorIntegrity,
  type PinnedManifest,
  pinnedManifest,
  purgeUnpinnedExecutors,
  sri384,
  UnpinnedWalletError,
  withoutDebugWallets,
} from "../../src/wallets/near/pinning";

// Stand-ins for the library's wallet classes (the real ones need a browser).
class SandboxWallet {
  constructor(readonly manifest: { id: string; executor: string; debug?: boolean }) {}
}
class InjectedWallet {
  readonly manifest = { id: "ext-wallet", executor: "" };
}
class ParentFrameWallet {
  constructor(readonly manifest: { id: string; executor: string }) {}
}
const classes = { SandboxWallet, InjectedWallet };

const PINNED_RAW = /^https:\/\/raw\.githubusercontent\.com\/[\w.-]+\/[\w.-]+\/[0-9a-f]{40}\/[^?#]+$/;
const HOT = PINNED_NEAR_MANIFEST.wallets.find((w) => w.id === "hot-wallet");

const constructed: Record<string, unknown>[] = [];
vi.mock("@hot-labs/near-connect", () => {
  class LocalStorage {
    readonly data = new Map<string, string>();
    async get(k: string) {
      return this.data.get(k) ?? null;
    }
    async set(k: string, v: string) {
      this.data.set(k, v);
    }
    async remove(k: string) {
      this.data.delete(k);
    }
  }
  class NearConnector {
    readonly db = { getItem: async () => null, removeItem: async () => {} };
    readonly options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      constructed.push(options);
    }
    private pick(id: string) {
      const m = (this.options.manifest as PinnedManifest).wallets.find((w) => w.id === id);
      if (!m) throw new Error("Wallet not found");
      const w = new SandboxWallet(m);
      return Object.assign(w, {
        getAccounts: async () => [{ accountId: "payer.near" }],
        signAndSendTransactions: vi.fn(async () => []),
        signMessage: vi.fn(async () => ({ accountId: "payer.near", publicKey: "ed25519:x", signature: "s" })),
      });
    }
    async selectWallet() {
      return "hot-wallet";
    }
    async wallet(id: string) {
      return this.pick(id);
    }
    async connect({ walletId }: { walletId: string }) {
      return this.pick(walletId);
    }
  }
  return { NearConnector, LocalStorage, SandboxWallet, InjectedWallet, ParentFrameWallet };
});

describe("pinned NEAR Connect manifest (snapshot)", () => {
  it("records its source commit", () => {
    expect(NEAR_SELECTOR_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(NEAR_MANIFEST_SOURCE).toBe(
      `https://raw.githubusercontent.com/hot-dao/near-selector/${NEAR_SELECTOR_COMMIT}/repository/manifest.json`,
    );
    expect(PINNED_NEAR_MANIFEST.wallets.length).toBeGreaterThan(0);
  });

  it("pins every executor to a full commit SHA, never a branch, with an SRI hash", () => {
    for (const w of PINNED_NEAR_MANIFEST.wallets) {
      expect(w.type).toBe("sandbox");
      expect(w.executor).not.toContain("refs/heads");
      expect(w.executor, w.id).toMatch(PINNED_RAW);
      expect(NEAR_EXECUTOR_INTEGRITY[w.executor], w.id).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
    }
    expect(JSON.stringify(PINNED_NEAR_MANIFEST)).not.toContain("refs/heads");
    // the near-selector executors use the manifest's own commit
    expect(HOT?.executor).toContain(`/hot-dao/near-selector/${NEAR_SELECTOR_COMMIT}/`);
  });

  it("has unique wallet ids and leaves out wallets that cannot be pinned", () => {
    const ids = PINNED_NEAR_MANIFEST.wallets.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of Object.keys(NEAR_EXCLUDED_WALLETS)) expect(ids).not.toContain(id);
    expect(Object.keys(NEAR_EXECUTOR_INTEGRITY).sort()).toEqual(
      [...new Set(PINNED_NEAR_MANIFEST.wallets.map((w) => w.executor))].sort(),
    );
  });

  it("hands out fresh copies", () => {
    const a = pinnedManifest();
    expect(a).toEqual(PINNED_NEAR_MANIFEST);
    expect(a).not.toBe(PINNED_NEAR_MANIFEST);
    a.wallets.length = 0;
    expect(pinnedManifest().wallets.length).toBe(PINNED_NEAR_MANIFEST.wallets.length);
  });
});

describe("executor integrity", () => {
  const url = HOT?.executor ?? "";
  const sri = NEAR_EXECUTOR_INTEGRITY[url];

  it("maps pinned executor requests (with the library's nonce) to their SRI hash", () => {
    expect(executorIntegrity(`${url}?nonce=6f1c`)).toBe(sri);
    expect(executorIntegrity(new URL(`${url}#x`))).toBe(sri);
    expect(executorIntegrity({ url } as Request)).toBe(sri);
    expect(executorIntegrity(`${url}?nonce=1&v=2`)).toBeUndefined();
    expect(executorIntegrity(url.replace(NEAR_SELECTOR_COMMIT, "refs/heads/main"))).toBeUndefined();
    expect(executorIntegrity("/api/v1/x")).toBeUndefined();
    expect(executorIntegrity("https://raw.githubusercontent.com/toString")).toBeUndefined();
  });

  it("wraps fetch once, adding integrity only to pinned executors", async () => {
    const calls: [unknown, RequestInit | undefined][] = [];
    const scope = {
      fetch: (async (input: unknown, init?: RequestInit) => {
        calls.push([input, init]);
        return new Response("ok");
      }) as typeof fetch,
    };
    installExecutorIntegrity(NEAR_EXECUTOR_INTEGRITY, scope);
    const first = scope.fetch;
    installExecutorIntegrity(NEAR_EXECUTOR_INTEGRITY, scope);
    expect(scope.fetch).toBe(first);
    await scope.fetch(`${url}?nonce=abc`);
    await scope.fetch("/api/v1/x", { method: "POST" });
    expect(calls[0]?.[1]).toEqual({ integrity: sri, credentials: "omit" });
    expect(calls[1]).toEqual(["/api/v1/x", { method: "POST" }]);
  });

  it("hashes like the browser does", async () => {
    const expected = `sha384-${createHash("sha384").update("console.log('é')", "utf8").digest("base64")}`;
    expect(await sri384("console.log('é')")).toBe(expected);
  });
});

describe("cached executors", () => {
  const manifest: PinnedManifest = {
    version: "1",
    wallets: [
      { id: "a", name: "A", icon: "", version: "1.0.0", executor: "https://x/a.js", type: "sandbox" },
      { id: "b", name: "B", icon: "", version: "1.0.0", executor: "https://x/b.js", type: "sandbox" },
      { id: "c", name: "C", icon: "", version: "2.0.0", executor: "https://x/c.js", type: "sandbox" },
      { id: "d", name: "D", icon: "", version: "1.0.0", executor: "https://x/d.js", type: "sandbox" },
    ],
  };

  it("keeps the pinned bytes and drops everything else", async () => {
    const integrity = {
      "https://x/a.js": await sri384("good"),
      "https://x/b.js": await sri384("good"),
      "https://x/c.js": await sri384("good"),
      "https://x/d.js": await sri384("good"),
    };
    const store = new Map<string, unknown>([
      ["a:1.0.0", "good"],
      ["b:1.0.0", "tampered"],
      ["c:2.0.0", 42],
    ]);
    const removed: string[] = [];
    await purgeUnpinnedExecutors(
      {
        getItem: async <T>(k: string) => (store.get(k) ?? null) as T | null,
        removeItem: async (k) => void removed.push(k),
      },
      manifest,
      integrity,
    );
    expect(removed).toEqual(["b:1.0.0", "c:2.0.0"]);
  });

  it("ignores an unreadable cache but fails closed when a removal fails", async () => {
    await expect(
      purgeUnpinnedExecutors(
        { getItem: () => Promise.reject(new Error("no idb")), removeItem: () => Promise.reject(new Error("x")) },
        manifest,
        {},
      ),
    ).resolves.toBeUndefined();
    await expect(
      purgeUnpinnedExecutors(
        { getItem: async <T>() => "old" as T, removeItem: () => Promise.reject(new Error("locked")) },
        manifest,
        {},
      ),
    ).rejects.toThrow("locked");
  });
});

describe("wallet guard", () => {
  const pinned = { id: HOT?.id ?? "", executor: HOT?.executor ?? "" };

  it("accepts pinned sandbox wallets and browser-extension wallets", () => {
    expect(() => assertPinnedWallet(new SandboxWallet(pinned), classes)).not.toThrow();
    expect(() => assertPinnedWallet(new InjectedWallet(), classes)).not.toThrow();
  });

  it("refuses debug, unknown, re-pointed and parent-frame wallets", () => {
    const bad = [
      new SandboxWallet({ ...pinned, debug: true }),
      new SandboxWallet({ id: "evil", executor: pinned.executor }),
      new SandboxWallet({ ...pinned, executor: "https://evil.example/x.js" }),
      new ParentFrameWallet(pinned),
      {},
    ];
    for (const w of bad) expect(() => assertPinnedWallet(w, classes)).toThrow(UnpinnedWalletError);
    expect(() => assertPinnedWallet({}, classes)).toThrow(/"unknown"/);
  });

  it("checks before and after sign-in", async () => {
    const parent = new ParentFrameWallet(pinned);
    const connector = {
      db: { getItem: async () => null, removeItem: async () => {} },
      selectWallet: async () => pinned.id,
      wallet: vi.fn(async () => new SandboxWallet(pinned) as SandboxWallet | ParentFrameWallet),
      connect: vi.fn(async () => parent as SandboxWallet | ParentFrameWallet),
    };
    await expect(connectPinnedWallet(connector, classes)).rejects.toThrow(UnpinnedWalletError);
    expect(connector.connect).toHaveBeenCalledWith({ walletId: pinned.id });
    connector.wallet.mockResolvedValueOnce(parent);
    connector.connect.mockClear();
    await expect(connectPinnedWallet(connector, classes)).rejects.toThrow(UnpinnedWalletError);
    expect(connector.connect).not.toHaveBeenCalled();
  });

  it("never persists debug wallets", async () => {
    const data = new Map<string, string>([["debug-wallets", "[{}]"]]);
    const s = withoutDebugWallets({
      get: async (k) => data.get(k) ?? null,
      set: async (k, v) => void data.set(k, v),
      remove: async (k) => void data.delete(k),
    });
    expect(await s.get("debug-wallets")).toBeNull();
    await s.set("debug-wallets", "[]");
    await s.set("selected-wallet", "hot-wallet");
    expect(await s.get("selected-wallet")).toBe("hot-wallet");
    expect(data.get("debug-wallets")).toBe("[{}]");
    await s.remove("selected-wallet");
    expect(data.has("selected-wallet")).toBe(false);
  });
});

describe("connectNearWallet", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    constructed.length = 0;
    vi.stubGlobal("document", {
      head: {},
      querySelector: () => ({ getAttribute: () => "bm9uY2Utbm9uY2Utbm9uY2U=" }),
    });
    vi.stubGlobal(
      "MutationObserver",
      class {
        observe() {}
      },
    );
    globalThis.fetch = (async () => new Response("")) as typeof fetch;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = realFetch;
  });

  it("constructs NearConnector with the pinned manifest and no auto-connect", async () => {
    const { connectNearWallet } = await import("../../src/wallets/near/connector");
    const wallet = await connectNearWallet();
    expect(wallet.accountId).toBe("payer.near");
    expect(constructed).toHaveLength(1);
    const options = constructed[0] as { manifest: PinnedManifest; autoConnect: boolean; cspNonce: string };
    expect(options.manifest).toEqual(PINNED_NEAR_MANIFEST);
    expect(options.manifest).not.toBe(PINNED_NEAR_MANIFEST);
    expect(options.manifest.wallets.every((w) => !w.executor.includes("refs/heads"))).toBe(true);
    expect(options.autoConnect).toBe(false);
    expect(options.cspNonce).toBe("bm9uY2Utbm9uY2Utbm9uY2U=");
    expect(typeof options.manifest).toBe("object");
    // the executor fetch now carries the SRI hash
    expect(
      (globalThis.fetch as unknown as Record<symbol, unknown>)[Symbol.for("nearpay.near-executor-integrity")],
    ).toBe(true);
  });
});
