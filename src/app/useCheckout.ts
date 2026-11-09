/**
 * Effects around the checkout state machine: session load, payment options, attempt creation, sentinel
 * verification (fail-closed), wallet payments, deposit signals, test-mode simulation, the live status
 * stream and the deposit deadline. The client secret lives only in this closure (§5.1).
 */
import {
  createDepositInstructionsAttestation,
  createPaymentAttempt,
  getPublicCheckoutSession,
  INTENTS_CONTRACT,
  listPaymentOptions,
  SOLANA_MAINNET,
  signalDepositSent,
  simulateDeposit,
  submitDepositTx,
  submitSignedIntent,
} from "@nearpay/spec";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { config } from "../config";
import { optionKey, payableOptions } from "../features/asset-picker/options";
import { openStatusStream } from "../features/status-stream/stream";
import type { WalletHandle } from "../features/wallet-connect/wallets";
import { call, isApiError } from "../lib/api/client";
import { NEAR_MAINNET, walletAsset } from "../lib/chains/chains";
import { type VerifiedInstructions, verifyAttestation } from "../lib/integrity/verify";
import { type AssetMeta, assetMeta, paidAssetId, totalToSend, walletTokenHint } from "../lib/money/display";
import { ensureChain, personalSign, sendTransaction, WalletRejected } from "../wallets/evm/provider";
import { evmPaymentTx } from "../wallets/evm/tx";
import {
  erc191Payload,
  intentMessage,
  makeNonce,
  nep413Message,
  nep413Payload,
  SANDBOX_SALT,
} from "../wallets/intents/message";
import { currentSalt, storageBalanceBounds, storageBalanceOf } from "../wallets/near/rpc";
import { depositTxHash, nearDepositTransactions } from "../wallets/near/tx";
import { accountOwner, latestBlockhash, type MintProgram, mintProgram, tokenAccountRent } from "../wallets/solana/rpc";
import {
  associatedTokenAddress,
  type SolanaManualReason,
  type SolanaRecipe,
  solanaPaymentTransaction,
  solanaRecipe,
} from "../wallets/solana/tx";
import {
  type BlockReason,
  hasLiveInstructions,
  initialState,
  type Option,
  type Path,
  reducer,
  type State,
} from "./machine";
import { INSUFFICIENT_FUNDS, TX_FAILED } from "./screens";

export interface CheckoutParams {
  readonly sessionId: string;
  readonly secret: string;
  /** Embedded mode: wait for the parent's verified `np:init` before loading the flow. */
  readonly enabled?: boolean;
}

export interface CheckoutActions {
  choosePath(path: Path): void;
  connected(wallet: WalletHandle): void;
  selectOption(o: Option): void;
  confirm(input: { refundTo?: string; turnstileToken: string }): Promise<void>;
  payWithWallet(): Promise<void>;
  signalSent(): Promise<void>;
  simulate(): Promise<void>;
  retry(): void;
  back(): void;
  /** "Change" on the review screen: pick another token or network. */
  change(): void;
  /** "Send from another wallet" from the wallet path. */
  useManual(): void;
  /** "Check status": reload the session now (the stream keeps running). */
  refresh(): Promise<void>;
  block(reason: BlockReason): void;
  clearError(): void;
}

export interface Checkout {
  readonly state: State;
  readonly actions: CheckoutActions;
  readonly busy: boolean;
  readonly streamMode: "sse" | "polling" | null;
  /** The payment option of the attempt's origin asset (from the payment options). */
  readonly originMeta: Option | null;
  /** Decimals/symbol of the paid asset: attested (`Attestation.asset`) when present, else from the options. */
  readonly assetMeta: AssetMeta | null;
  /**
   * The last verified attestation of this page load. It stays after the instructions are hidden so the
   * attested merchant name and destination keep being shown on the status screens (never the
   * unverified display name, L-CK-03).
   */
  readonly trusted: VerifiedInstructions | null;
  /** Wallet re-quote: total of the expired quote when the new one differs (base units, same asset). */
  readonly previousTotal: string | null;
  /** Option of the expired wallet quote, re-selected automatically after "Get a new quote". */
  readonly requoteKey: string | null;
  /** Solana wallet path readiness for the verified quote (§11); null for other wallets. */
  readonly solana: SolanaPrep | null;
  /** Re-run the Solana checks after an RPC error. */
  readonly retrySolana: () => void;
}

/**
 * Solana wallet path after verification (§11): `checking` (RPC: mint owner, deposit token account),
 * `ready` (with the token-account rent the payer adds, when the deposit ATA does not exist yet),
 * `manual` (no wallet recipe — memo, Token-2022, unreconciled mint …: manual path only), `error` (RPC).
 */
export type SolanaPrep =
  | { readonly state: "checking" }
  | { readonly state: "ready"; readonly recipe: SolanaRecipe; readonly rentLamports: string | null }
  | { readonly state: "manual"; readonly reason: SolanaManualReason }
  | { readonly state: "error" };

/** Field equality of two Solana recipes (kind, deposit, amount, mint, decimals). */
export function sameRecipe(a: SolanaRecipe, b: SolanaRecipe): boolean {
  if (a.kind === "sol" || b.kind === "sol") {
    return a.kind === "sol" && b.kind === "sol" && a.deposit === b.deposit && a.lamports === b.lamports;
  }
  return a.deposit === b.deposit && a.mint === b.mint && a.amount === b.amount && a.decimals === b.decimals;
}

function errorCode(e: unknown): string {
  if (e instanceof WalletRejected) return "wallet_rejected";
  if (isApiError(e)) return e.code === "insufficient_balance" ? INSUFFICIENT_FUNDS : e.code;
  // Wallets report a short balance as an RPC error ("insufficient funds for gas * price + value",
  // "Not enough balance", NEAR "NotEnoughBalance", Solana "insufficient lamports" / "no record of a
  // prior credit").
  if (
    e instanceof Error &&
    /insufficient (funds|balance|lamports)|not ?enough ?balance|no record of a prior credit/i.test(e.message)
  ) {
    return INSUFFICIENT_FUNDS;
  }
  if (e instanceof Error && e.name === "SolanaSendFailed") return TX_FAILED;
  return "generic";
}

export function useCheckout({ sessionId, secret, enabled = true }: CheckoutParams): Checkout {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [busy, setBusy] = useState(false);
  const [streamMode, setStreamMode] = useState<"sse" | "polling" | null>(null);
  const [originMeta, setOriginMeta] = useState<Option | null>(null);
  const [trusted, setTrusted] = useState<VerifiedInstructions | null>(null);
  const [previousTotal, setPreviousTotal] = useState<string | null>(null);
  const [requoteKey, setRequoteKey] = useState<string | null>(null);
  /** The wallet quote that was on screen when it expired (option key + total). */
  const lastQuote = useRef<{ key: string; total: string; asset: string } | null>(null);
  const wallet = useRef<WalletHandle | null>(null);
  const verifying = useRef<string | null>(null);
  const sessionLoaded = state.session !== null;

  // ---- session load ---------------------------------------------------------------------------
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    call(getPublicCheckoutSession, { params: { id: sessionId }, secret })
      .then((session) => !cancelled && dispatch({ type: "session_loaded", session }))
      .catch((e) => {
        if (cancelled) return;
        dispatch({
          type: "blocked",
          reason:
            isApiError(e, "client_secret_invalid") || isApiError(e, "resource_missing")
              ? "secret_invalid"
              : "load_failed",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, secret, enabled]);

  // ---- live status ------------------------------------------------------------------------------
  const terminal = state.phase === "succeeded" || state.phase === "blocked";
  useEffect(() => {
    if (!enabled || !sessionLoaded || terminal) return;
    const stop = openStatusStream(
      { sessionId, secret },
      {
        onMessage: (m) => {
          if (m.kind === "session") dispatch({ type: "stream_session", session: m.session });
          else if (m.kind === "attempt") dispatch({ type: "stream_attempt", attempt: m.attempt });
          else dispatch({ type: "stream_intent", intent: m.intent });
        },
        onMode: setStreamMode,
      },
    );
    return stop;
  }, [sessionId, secret, enabled, sessionLoaded, terminal]);

  // ---- payment options ----------------------------------------------------------------------------
  const { phase, options, path, wallet: connected } = state;
  useEffect(() => {
    if (phase !== "choose_asset" || options !== null || !path) return;
    let cancelled = false;
    const family = connected?.family ?? null;
    const query: Record<string, string | undefined> =
      path === "wallet" && connected
        ? {
            wallet: connected.address,
            chain: family === "near" ? NEAR_MAINNET : family === "solana" ? SOLANA_MAINNET : undefined,
          }
        : {};
    call(listPaymentOptions, { params: { id: sessionId }, query, secret })
      .then((r) => !cancelled && dispatch({ type: "options_loaded", options: payableOptions(r.options, path, family) }))
      .catch((e) => {
        if (cancelled) return;
        if (isApiError(e, "session_not_open")) dispatch({ type: "blocked", reason: "session_expired" });
        else {
          dispatch({ type: "options_loaded", options: [] });
          dispatch({ type: "error", error: { code: errorCode(e) } });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [phase, options, path, connected, sessionId, secret]);

  // Asset metadata for resumed attempts (no option chosen in this page load).
  const attemptAsset = state.attempt?.origin_asset_id ?? null;
  useEffect(() => {
    if (!attemptAsset) return;
    if (state.option?.origin_asset_id === attemptAsset) {
      setOriginMeta(state.option);
      return;
    }
    let cancelled = false;
    call(listPaymentOptions, { params: { id: sessionId }, secret })
      .then((r) => !cancelled && setOriginMeta(r.options.find((o) => o.origin_asset_id === attemptAsset) ?? null))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [attemptAsset, state.option, sessionId, secret]);

  // ---- sentinel verification (fail-closed) -------------------------------------------------------
  const attempt = state.attempt;
  useEffect(() => {
    if (phase !== "verifying" || !attempt || !hasLiveInstructions(attempt)) return;
    if (verifying.current === attempt.id) return;
    verifying.current = attempt.id;
    const body =
      attempt.method === "route_quote" && attempt.deposit
        ? {
            livemode: attempt.livemode,
            kind: "route_quote" as const,
            attempt_id: attempt.id,
            attestation_ticket: attempt.attestation_ticket as string,
            deposit: {
              address: attempt.deposit.address,
              memo: attempt.deposit.memo,
              chain: attempt.deposit.chain,
              origin_asset_id: attempt.deposit.origin_asset_id,
              amount_in: attempt.deposit.amount_in,
              deadline: attempt.deposit.deadline,
            },
          }
        : {
            livemode: attempt.livemode,
            kind: "intents_transfer" as const,
            attempt_id: attempt.id,
            attestation_ticket: attempt.attestation_ticket as string,
            requirement: { ...(attempt.intents_requirement as NonNullable<typeof attempt.intents_requirement>) },
          };
    call(createDepositInstructionsAttestation, { body, raw: true })
      .then((raw) => {
        const r = verifyAttestation(raw, config.sentinelKeys, attempt, Date.now());
        if (r.ok) dispatch({ type: "verified", verified: r.verified });
        else dispatch({ type: "verify_failed", reason: r.reason, ...(r.field ? { field: r.field } : {}) });
      })
      .catch((e) => dispatch({ type: "verify_failed", reason: isApiError(e) ? e.code : "network_error" }))
      .finally(() => {
        verifying.current = null;
      });
  }, [phase, attempt]);

  // ---- attested display data + wallet re-quote ------------------------------------------------------
  const verified = state.verified;
  useEffect(() => {
    if (!verified) return;
    setTrusted(verified);
    if (state.path !== "wallet" || !state.option) return;
    const total = totalToSend(verified.attestation);
    const asset = paidAssetId(verified.attestation);
    const key = optionKey(state.option);
    const prev = lastQuote.current;
    setPreviousTotal(
      prev && total && asset && prev.key === key && prev.asset === asset && prev.total !== total ? prev.total : null,
    );
    setRequoteKey(null);
    if (total && asset) lastQuote.current = { key, total, asset };
  }, [verified, state.path, state.option]);

  // ---- deposit deadline ---------------------------------------------------------------------------
  const validUntil = state.verified?.validUntil ?? null;
  useEffect(() => {
    if (validUntil === null) return;
    const ms = validUntil - Date.now();
    if (ms <= 0) {
      dispatch({ type: "deadline_passed" });
      return;
    }
    const t = setTimeout(() => dispatch({ type: "deadline_passed" }), Math.min(ms, 2_147_000_000));
    return () => clearTimeout(t);
  }, [validUntil]);

  // ---- Solana wallet path checks (§11) ----------------------------------------------------------------
  const [solana, setSolana] = useState<SolanaPrep | null>(null);
  const [solanaRun, setSolanaRun] = useState(0);
  const solanaWallet = state.phase === "pay_wallet" && state.wallet?.family === "solana";
  const livemode = state.session?.livemode ?? false;
  useEffect(() => {
    void solanaRun; // "Try again" after an RPC error re-runs the checks
    if (!solanaWallet || !verified) {
      setSolana(null);
      return;
    }
    const r = solanaRecipe(verified.attestation);
    if (!r) {
      setSolana({ state: "manual", reason: "token" });
      return;
    }
    if (!r.ok) {
      setSolana({ state: "manual", reason: r.reason });
      return;
    }
    const recipe = r.recipe;
    // Test mode never broadcasts (§5.8): no RPC reads either.
    if (!livemode || recipe.kind === "sol") {
      setSolana({ state: "ready", recipe, rentLamports: null });
      return;
    }
    let cancelled = false;
    setSolana({ state: "checking" });
    const url = config.solanaRpcUrl;
    void (async () => {
      try {
        const program: MintProgram = await mintProgram(url, recipe.mint);
        if (cancelled) return;
        if (program !== "token") {
          setSolana({ state: "manual", reason: program === "token_2022" ? "token_2022" : "mint_unknown" });
          return;
        }
        const ata = associatedTokenAddress(recipe.deposit, recipe.mint).address;
        const exists = (await accountOwner(url, ata)) !== null;
        const rent = exists ? null : await tokenAccountRent(url);
        if (!cancelled) setSolana({ state: "ready", recipe, rentLamports: rent });
      } catch {
        if (!cancelled) setSolana({ state: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [solanaWallet, verified, livemode, solanaRun]);

  // ---- actions ----------------------------------------------------------------------------------------
  const reload = useCallback(async () => {
    try {
      const session = await call(getPublicCheckoutSession, { params: { id: sessionId }, secret });
      dispatch({ type: "stream_session", session });
    } catch {
      /* the stream / polling keeps trying */
    }
  }, [sessionId, secret]);

  const confirm = useCallback<CheckoutActions["confirm"]>(
    async ({ refundTo, turnstileToken }) => {
      const s = state;
      const o = s.option;
      if (!o || s.phase !== "choose_asset") return;
      const w = wallet.current;
      let body: Record<string, string>;
      if (o.method === "intents_transfer") {
        if (!w || w.family === "solana") return;
        body = {
          method: o.method,
          origin_asset_id: o.origin_asset_id,
          payer_wallet: w.family === "evm" ? w.address.toLowerCase() : w.address,
          turnstile_token: turnstileToken,
        };
      } else {
        const refund = s.path === "wallet" ? w?.address : refundTo?.trim();
        if (!refund) return;
        body = {
          method: o.method,
          origin_asset_id: o.origin_asset_id,
          refund_to: refund,
          turnstile_token: turnstileToken,
        };
      }
      dispatch({ type: "confirm" });
      setBusy(true);
      try {
        const created = await call(createPaymentAttempt, { params: { id: sessionId }, body, secret });
        dispatch({ type: "attempt_created", attempt: created });
      } catch (e) {
        const code = errorCode(e);
        dispatch({ type: "attempt_failed", error: { code, param: isApiError(e) ? e.param : null } });
        if (code === "attempt_in_flight" || code === "state_conflict") void reload();
      } finally {
        setBusy(false);
      }
    },
    [state, sessionId, secret, reload],
  );

  const payWithWallet = useCallback(async () => {
    const v = state.verified;
    const a = state.attempt;
    const w = wallet.current;
    if (state.phase !== "pay_wallet" || !v || !a || !w) return;
    if (!a.livemode) return; // INV-8: test mode never broadcasts; the UI offers "Simulate payment".
    setBusy(true);
    dispatch({ type: "error", error: null });
    try {
      const att = v.attestation;
      if (w.family === "solana") {
        // §11: only the recipe derived from the verified attestation (and checked over RPC) is sent.
        // The RPC-checked recipe must be the one of THIS verified attestation (a re-quote re-runs the checks).
        const fresh = solanaRecipe(att);
        if (solana?.state !== "ready" || !fresh?.ok || !sameRecipe(fresh.recipe, solana.recipe)) {
          throw new Error("This payment can't be sent from a Solana wallet.");
        }
        const blockhash = await latestBlockhash(config.solanaRpcUrl);
        const tx = solanaPaymentTransaction(solana.recipe, w.address, blockhash);
        const signature = await w.wallet.signAndSendTransaction(tx);
        dispatch({ type: "paid" });
        await call(submitDepositTx, {
          params: { id: sessionId, attempt: a.id },
          body: { tx_hash: signature },
          secret,
        }).catch(() => undefined);
      } else if (att.kind === "route_quote" && att.deposit) {
        const d = att.deposit;
        // The recipe comes from the attested asset id; the signed `Attestation.asset.token` (spec 0.2.1)
        // wins, else the option's typed token (CR-15-06) — only when that option describes the same
        // attested asset and chain (never for another asset). Contradictions disable the wallet path.
        const meta = optionFor(state.option, originMeta, d.origin_asset_id, d.chain);
        const asset = walletAsset(d.origin_asset_id, d.chain, walletTokenHint(att, meta?.token));
        if (!asset) throw new Error("This asset can't be paid from a wallet here.");
        let txHash: string;
        if (w.family === "evm" && (asset.kind === "evm_erc20" || asset.kind === "evm_native")) {
          await ensureChain(w.provider, d.chain);
          txHash = await sendTransaction(w.provider, evmPaymentTx(asset, d.address, d.amount_in, w.address));
        } else if (w.family === "near" && (asset.kind === "near_nep141" || asset.kind === "near_wrap")) {
          const [registered, bounds] = await Promise.all([
            storageBalanceOf(config.nearRpcUrl, asset.token, d.address),
            storageBalanceBounds(config.nearRpcUrl, asset.token),
          ]);
          const txs = nearDepositTransactions({
            asset,
            depositAddress: d.address,
            amountIn: d.amount_in,
            memo: d.memo,
            registered: registered !== null,
            storageMin: bounds.min,
          });
          txHash = depositTxHash(await w.wallet.signAndSendTransactions(txs));
        } else {
          throw new Error("This wallet can't pay this asset.");
        }
        dispatch({ type: "paid" });
        await call(submitDepositTx, {
          params: { id: sessionId, attempt: a.id },
          body: { tx_hash: txHash },
          secret,
        }).catch(() => undefined);
      } else if (att.kind === "intents_transfer" && att.requirement) {
        const salt = a.livemode ? await currentSalt(config.nearRpcUrl, INTENTS_CONTRACT) : SANDBOX_SALT;
        const signer = w.family === "evm" ? w.address.toLowerCase() : w.address;
        const msg = intentMessage(att.requirement, signer, makeNonce(salt));
        const signed =
          w.family === "near"
            ? nep413Payload(
                msg,
                await w.wallet.signMessage({
                  message: nep413Message(msg),
                  recipient: INTENTS_CONTRACT,
                  nonce: Uint8Array.from(atob(msg.nonce), (c) => c.charCodeAt(0)),
                }),
              )
            : erc191Payload(msg, await personalSign(w.provider, JSON.stringify(msg), w.address));
        await call(submitSignedIntent, { params: { id: sessionId, attempt: a.id }, body: { signed }, secret });
        dispatch({ type: "paid" });
      }
    } catch (e) {
      dispatch({
        type: "error",
        error: {
          code: errorCode(e) === "generic" ? "wallet_failed" : errorCode(e),
          param: e instanceof Error ? e.message.slice(0, 200) : null,
        },
      });
    } finally {
      setBusy(false);
    }
  }, [state, sessionId, secret, originMeta, solana]);

  const signalSent = useCallback(async () => {
    const a = state.attempt;
    if (!a || state.phase !== "pay_manual") return;
    setBusy(true);
    try {
      await call(signalDepositSent, { params: { id: sessionId, attempt: a.id }, body: {}, secret });
    } catch {
      /* the deposit is detected without the signal */
    } finally {
      setBusy(false);
      dispatch({ type: "paid" });
    }
  }, [state, sessionId, secret]);

  const simulate = useCallback(async () => {
    const a = state.attempt;
    if (!a || a.livemode || (state.phase !== "pay_manual" && state.phase !== "pay_wallet")) return;
    setBusy(true);
    try {
      await call(simulateDeposit, { params: { id: sessionId, attempt: a.id }, body: {}, secret });
      dispatch({ type: "paid" });
    } catch (e) {
      dispatch({ type: "error", error: { code: errorCode(e) } });
    } finally {
      setBusy(false);
    }
  }, [state, sessionId, secret]);

  const actions: CheckoutActions = {
    choosePath: (p) => dispatch({ type: "choose_path", path: p }),
    connected: (w) => {
      wallet.current = w;
      dispatch({ type: "wallet_connected", wallet: { family: w.family, address: w.address, label: w.label } });
    },
    selectOption: (o) => dispatch({ type: "select_option", option: o }),
    confirm,
    payWithWallet,
    signalSent,
    simulate,
    retry: () => {
      // Wallet path "Get a new quote": re-select the same option and ask the payer to review any change.
      const q = lastQuote.current;
      setRequoteKey(state.path === "wallet" && state.phase === "expired_address" && q ? q.key : null);
      dispatch({ type: "retry" });
    },
    change: () => {
      lastQuote.current = null;
      setPreviousTotal(null);
      dispatch({ type: "change" });
    },
    useManual: () => {
      wallet.current = null;
      lastQuote.current = null;
      setPreviousTotal(null);
      dispatch({ type: "use_manual" });
    },
    refresh: reload,
    back: () => {
      wallet.current = null;
      dispatch({ type: "back" });
    },
    block: (reason) => dispatch({ type: "blocked", reason }),
    clearError: () => dispatch({ type: "error", error: null }),
  };

  const attestation = state.verified?.attestation ?? trusted?.attestation ?? null;
  const paid = attestation ? paidAssetId(attestation) : (state.attempt?.origin_asset_id ?? null);
  const meta = paid ? assetMeta(paid, attestation, [state.option, originMeta]) : null;
  return {
    state,
    actions,
    busy,
    streamMode,
    originMeta,
    assetMeta: meta,
    trusted,
    previousTotal: state.phase === "pay_wallet" ? previousTotal : null,
    requoteKey,
    solana,
    retrySolana: () => setSolanaRun((n) => n + 1),
  };
}

/** The payment option describing exactly `assetId` on `chain` (selected one first). */
function optionFor(selected: Option | null, origin: Option | null, assetId: string, chain: string): Option | null {
  for (const o of [selected, origin]) if (o && o.origin_asset_id === assetId && o.chain === chain) return o;
  return null;
}
