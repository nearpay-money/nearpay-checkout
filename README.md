# nearpay-checkout

The payer-facing app: hosted checkout, payment links, hosted invoices and the embedded iframe app, with wallet adapters, deposit instructions and live payment status.

Part of [NearPay](https://github.com/nearpay-money/nearpay) — start there for the live demo, the architecture diagram and the full "do X, see Y" walkthrough.

- **Where it sits:** a static single-page app served at https://pay.nearpay.money; the `nearpay-js` loader frames its `/embed` route on merchant sites. It calls the payer routes of payments and billing and sentinel's co-signing route through the gateway (same origin, `/api`), and talks to the payer's wallet. It shows a deposit address only after verifying sentinel's signature against keys pinned at build time.
- **Status:** NearPay runs on NEAR mainnet as a closed beta (https://nearpay.money). This app is the hosted checkout of that deployment.

| | |
|---|---|
| Group | Frontends |
| Kind | static SPA |
| Ships as | pay.nearpay.money |
| Owns | — (stateless) |
| Depends on (published artifacts only) | spec (public), gateway |
| First built in | Stage 1 (step 1.3) |

## Documentation

Design docs live in [`nearpay-brain`](https://github.com/nearpay-money/nearpay-brain), not here.

- [`lld/checkout-and-js.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/lld/checkout-and-js.md) — low-level design this repo is implemented from
- [`lld/audits/checkout-and-js.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/lld/audits/checkout-and-js.md) — audit findings already folded into the LLD
- [`roadmap/development-plan.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/roadmap/development-plan.md) — stage and step this repo is built in
- [`decisions/ADR-0010-checkout-isolation.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/decisions/ADR-0010-checkout-isolation.md)
- [`architecture/flows.md#2-checkout--cross-chain-any-asset-the-main-path`](https://github.com/nearpay-money/nearpay-brain/blob/main/architecture/flows.md#2-checkout--cross-chain-any-asset-the-main-path)

## Routes

| Path | What |
|---|---|
| `/c/:cs_id#<client_secret>` | hosted checkout (never framed) |
| `/embed/:cs_id#<client_secret>` | embedded checkout, framed by `nearpay-js`; accepts `np:init` only from `allowed_origins` |
| `/l/:id` | payment link (Stage 2): anonymous link page → `createPaymentLinkSession` → continues as `/c/:id#<client_secret>` |
| `/l/:id/complete` | confirmation page of a link without a merchant redirect: says only "You can close this page" (no secret in the URL, so no payment state is shown) |
| `/i/:id#<invoice_secret>` | hosted invoice (Stage 3): invoice, PDF, "Pay invoice" → the checkout flow in place (lazy-loaded chunk); Stage 4: auto-pay setup and management (vault mandate funded from the payer's own NEAR account) |

After a payment the hosted checkout returns to the session's `success_url` (2.5 s delay plus a link). A payment
link without a merchant redirect has the checkout's own `/l/:id/complete` as `success_url`; the checkout then does
not redirect and "Payment complete" is the final screen.

The client secret stays in the URL fragment and in memory; it is sent only as `X-NearPay-Client-Secret`.
The invoice secret likewise, only as `X-NearPay-Invoice-Secret`; a wrong secret, an unknown invoice and a
malformed link all show the same "Invoice not found".

**Serving:** every hosted route (`/c/*`, `/l/*`, `/i/*`) needs the hosted CSP (meta in `index.html`, nonce
substituted) plus the header `frame-ancestors 'none'`, and `Referrer-Policy: no-referrer` (the page also
sets `<meta name="referrer" content="no-referrer">`; `nearpay-deploy`'s `compose/static/nginx.conf` sends
`no-referrer` for these paths).

## Verify this repo

Needs Node 22 (`.nvmrc`), pnpm 9 and, for step 4, Google Chrome. No Docker. `.npmrc` points the `@nearpay-money` and `@nearpay-internal` scopes at a local package registry, so start that first.

1. Start the local registry (no Docker, Node 22 only):
   `git clone https://github.com/nearpay-money/nearpay-deploy ../nearpay-deploy && ../nearpay-deploy/scripts/registry.sh start`
   → `curl http://127.0.0.1:4873/-/ping` answers `{}`.
2. `pnpm install --frozen-lockfile` → ends with `Done in …`, no registry errors.
3. `pnpm test` (unit tests, including the shared `@nearpay-money/spec` test vectors) → `Test Files  17 passed (17)`, `Tests  238 passed (238)`.
4. The full gate, `pnpm verify` (typecheck, lint, unit tests with the coverage gate, production build, Playwright end-to-end tests against an in-process mock of the payer API and sentinel). The production build refuses to run without pinned sentinel public keys, so on a checkout without a seeded `nearpay-deploy` pin the spec's public test-vector key first:

   ```sh
   export VITE_SENTINEL_KEYS="$(node -e 'const k=require("@nearpay-money/spec/test-vectors/sentinel-attestation.json").key;console.log(JSON.stringify([{kid:k.kid,public_key:k.public_key_base64url}]))')"
   pnpm verify
   ```

   → exits 0; the Playwright list ends with `90 passed` and `36 skipped` (about 3 minutes). The browser is the system Chrome at `/usr/bin/google-chrome`; set `NP_CHROME` to another path if needed. Without `VITE_SENTINEL_KEYS` (or `NP_SENTINEL_KEYS_FILE`) the build step stops with `no pinned sentinel keys`, which is the intended behaviour.

To pay through this app for real, follow the walkthrough in the [entry repo](https://github.com/nearpay-money/nearpay).

## Build

```
pnpm install --frozen-lockfile
pnpm build          # → dist/ (index.html + hashed assets/), served by nearpay-deploy's `pay` site
```

Build-time constants (everything ends up in the public bundle — nothing secret):

| Variable | Default | Meaning |
|---|---|---|
| `VITE_SENTINEL_KEYS` | — | JSON `[{kid, public_key}]`, the **pinned** sentinel keys |
| `NP_SENTINEL_KEYS_FILE` | `../nearpay-deploy/.secrets/public/sentinel_keys.json` | file with the same JSON (written by `nearpay-deploy/scripts/seed.sh keys`); the build fails when no keys are found |
| `VITE_API_ORIGIN` | `/api` | payer API + sentinel, same origin through the gateway |
| `VITE_TURNSTILE_SITEKEY` | `1x00000000000000000000AA` | Cloudflare's always-pass test sitekey (pairs with the local stack's test secret) |
| `VITE_NEAR_NETWORK` | `mainnet` | NEAR Connect network |
| `VITE_NEAR_RPC_URL` | `https://free.rpc.fastnear.com` | NEAR view calls (storage registration, Verifier salt) |
| `VITE_SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana wallet path: blockhash, mint owner, deposit token account, rent (origin added to CSP `connect-src`) |
| `VITE_WALLETCONNECT_PROJECT_ID` | empty | reserved; WalletConnect is not wired yet |
| `VITE_WEB_URL` | `https://nearpay.money` | site origin for the footer links (Help · Privacy · Terms) |

`index.html` carries the CSP as a meta tag (`frame-ancestors` comes from the static server per route).
It contains the placeholder `{{NP_CSP_NONCE}}` (also in `<meta name="np-csp-nonce">`): the static
server must replace it with a per-response nonce for NEAR Connect's sandboxed wallet frames to run
(`nearpay-deploy`'s nginx does, with `sub_filter`). Served without that substitution, the placeholder is
an invalid CSP source (the policy stays strict) and NEAR wallets are shown as unavailable.

## Tests

```
pnpm test           # unit (Vitest), shared @nearpay-money/spec test vectors
pnpm coverage       # + coverage gate (90 % branches on the money-path and state modules)
pnpm e2e            # vite build --mode e2e → dist-e2e/, then Playwright against an in-process mock
pnpm verify         # typecheck + lint + coverage + build + e2e
```

The Playwright suite uses the system Chrome (`/usr/bin/google-chrome`, override with `NP_CHROME`).
`test/e2e/support/mock-server.ts` serves `dist-e2e/` plus the payer routes and sentinel co-signing,
validating every request and response with the spec schemas and signing attestations with the
spec's test-vector key (pinned only in the e2e build).

## Status

Current: spec 0.5.2 and `@nearpay-internal/ui` 0.5.0 (`package.json`); landing-page card layout with chain and
token logos; light pay side by default (dark or auto only when a merchant asks); asset ids in the 1Click
`.omft.near`, `.omdep.near` and `1cs_v1:` shapes. Auto-pay on hosted invoices needs the subscription vault,
which is not deployed on mainnet yet (planned account `v1.nearpay-money.near`); test mode uses the sandbox's
simulated vault.

Payment links without a merchant redirect end on "Payment complete" (no redirect to the checkout's own
`/l/:id/complete`, which is now a page for sessions opened earlier). Initial JS 182,269 bytes gzipped (Vite prints
182.27 kB; 178.0 KB at 1,024 bytes, budget 180 KB), 730 bytes less than before: the hosted invoice copy moved into
the lazy invoice chunk (31.7 kB).

Step 4.3 (spec 0.4.0):
Solana wallets through the Wallet Standard (SOL `System.Transfer`, SPL `CreateIdempotent` +
`TransferChecked` from the verified attestation only, byte-for-byte against `solana-transfer.json`;
memo / Token-2022 / unreconciled mint → manual path), Solana Pay and BIP-21 QR on the manual path, and
hosted invoice auto-pay (terms from the parsed vault `msg`, transactions checked before the payer's NEAR
wallet signs, mandate status, top-up / cancel / withdraw; test mode never signs). Screenshot tour:
`NP_SHOTS=<dir> pnpm exec playwright test screens-4.3`.

Step 3.3: hosted invoices `/i/:id` (all states: open, overdue, past due/uncollectible, not payable, paid
receipt, void, expired session, not found, test mode; PDF download; pay hand-off into the unchanged
checkout flow), spec 0.3.0 / ui 0.3.0, spec 0.2.1 checkout fields (`DepositInstructions.fee_amount`,
`PayerAttempt.amount_received`, `pricing_asset`, `Attestation.asset.token`). Initial JS 172.1 KB gzipped
(budget 180 KB); the invoice page is a 12.4 KB lazy chunk. Screenshot tour includes the invoice screens.

Step 2.3: every screen rebuilt on `@nearpay-internal/ui` to the owner's Figma checkout canvas (phase →
frame mapping in `src/app/screens.ts`), payment links, spec 0.2.0 fields (`PaymentOption.token`,
`Attestation.asset`). Screenshot tour: `NP_SHOTS=<dir> pnpm exec playwright test screens` (after
`pnpm build:e2e`).

Stage 1 (step 1.3): hosted + embedded checkout, manual path, EVM (EIP-6963) and NEAR (NEAR Connect)
wallets, Intents-balance signing (NEP-413 / ERC-191), sentinel verification, live status (SSE +
polling), test mode. WalletConnect is not built yet.

## Built with

- Runtime: Vite, React 19, TypeScript; `@nearpay-internal/ui` (NearPay design system); zod + `@nearpay-money/spec`; `@noble/curves` / `@noble/hashes` (Ed25519, SHA-256, keccak); `canonicalize` (RFC 8785); `bs58`; `uqr` (QR codes); `@hot-labs/near-connect` (NEAR wallets, lazy-loaded); `@wallet-standard/app` and `@wallet-standard/base` (Solana wallets); Cloudflare Turnstile (runtime script).
- Tests and tooling: Vitest, Playwright, Biome; `@web3icons/core` (chain and token logos, build time).
- Licence: Apache-2.0 (`LICENSE`).

Code and documentation are written with AI assistance (Claude) under human direction and review. Built for the NEAR Hackathon (Nov 2026).
