# nearpay-checkout

> Hosted checkout, payment links, hosted invoices and the embedded iframe app; wallet adapters; deposit instructions; live status.

| | |
|---|---|
| Group | Frontends |
| Kind | static SPA |
| Ships as | pay.nearpay.money |
| Owns | — (stateless) |
| Depends on (published artifacts only) | spec (public), gateway |
| First built in | Stage 1 (step 1.3) |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

- `nearpay-brain/lld/checkout-and-js.md` — **low-level design (dev-ready; implement from this)**
- `nearpay-brain/lld/audits/checkout-and-js.md` — audit findings already folded into the LLD
- `nearpay-brain/roadmap/development-plan.md` — stage and step this repo is built in
- `nearpay-brain/decisions/ADR-0010-checkout-isolation.md`
- `nearpay-brain/architecture/flows.md#2-checkout--cross-chain-any-asset-the-main-path`

## Routes

| Path | What |
|---|---|
| `/c/:cs_id#<client_secret>` | hosted checkout (never framed) |
| `/embed/:cs_id#<client_secret>` | embedded checkout, framed by `nearpay-js`; accepts `np:init` only from `allowed_origins` |
| `/l/:id` | payment link (Stage 2): anonymous link page → `createPaymentLinkSession` → continues as `/c/:id#<client_secret>` |
| `/i/:id` | hosted invoices (Stage 3): "not available yet" |

The client secret stays in the URL fragment and in memory; it is sent only as `X-NearPay-Client-Secret`.

## Build

```
pnpm install
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
| `VITE_WALLETCONNECT_PROJECT_ID` | empty | reserved; WalletConnect is not wired yet |
| `VITE_WEB_URL` | `https://nearpay.money` | site origin for the footer links (Help · Privacy · Terms) |

`index.html` carries the CSP as a meta tag (`frame-ancestors` comes from the static server per route).
It contains the placeholder `{{NP_CSP_NONCE}}` (also in `<meta name="np-csp-nonce">`): the static
server must replace it with a per-response nonce for NEAR Connect's sandboxed wallet frames to run.
Until it does, the placeholder is an invalid CSP source (the policy stays strict) and NEAR wallets
are shown as unavailable.

## Tests

```
pnpm test           # unit (Vitest), shared @nearpay/spec test vectors
pnpm coverage       # + coverage gate (90 % branches on the money-path and state modules)
pnpm e2e            # vite build --mode e2e → dist-e2e/, then Playwright against an in-process mock
pnpm verify         # typecheck + lint + coverage + build + e2e
```

The Playwright suite uses the system Chrome (`/usr/bin/google-chrome`, override with `NP_CHROME`).
`test/e2e/support/mock-server.ts` serves `dist-e2e/` plus the payer routes and sentinel co-signing,
validating every request and response with the spec schemas and signing attestations with the
spec's test-vector key (pinned only in the e2e build).

## Status

Step 2.3: every screen rebuilt on `@nearpay-internal/ui` to the owner's Figma checkout canvas (phase →
frame mapping in `src/app/screens.ts`), payment links, spec 0.2.0 fields (`PaymentOption.token`,
`Attestation.asset`). Screenshot tour: `NP_SHOTS=<dir> pnpm exec playwright test screens` (after
`pnpm build:e2e`).

Stage 1 (step 1.3): hosted + embedded checkout, manual path, EVM (EIP-6963) and NEAR (NEAR Connect)
wallets, Intents-balance signing (NEP-413 / ERC-191), sentinel verification, live status (SSE +
polling), test mode. Hosted invoices (Stage 3), Solana wallets (Stage 4) and WalletConnect are not
built yet.

## Built with

Vite, React, TypeScript, `@nearpay-internal/ui` (NearPay design system, DM Sans self-hosted), zod + `@nearpay/spec`, `@noble/curves` / `@noble/hashes` (Ed25519, SHA-256,
keccak), `canonicalize` (RFC 8785), `bs58`, `uqr` (QR codes), `@hot-labs/near-connect` (NEAR wallets,
lazy-loaded), Cloudflare Turnstile (runtime script), Vitest, Playwright, Biome. Code and documentation
are written with AI assistance (Claude) under human direction and review.
