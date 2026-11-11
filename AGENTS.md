# AGENTS.md — nearpay-checkout

You are working in **nearpay-checkout**, one of 27 NearPay repositories (`nearpay-brain/architecture/repositories.md`).
Scope: Hosted checkout, payment links, hosted invoices and the embedded iframe app; wallet adapters; deposit instructions; live status.

## Before changing anything

1. Read `../nearpay-brain/AGENTS.md`, then this repo's LLD (`../nearpay-brain/lld/checkout-and-js.md`) — it is the implementation spec; do not make design decisions it already makes.
2. Contracts (requests, responses, events, errors) come from `@nearpay-money/spec`. If one must change, open a PR in `nearpay-spec` first; never hand-write contract types here.
3. Check your change against invariants INV-1…INV-9 in `nearpay-brain/product/requirements.md`.

## Rules for this repo

- Talk only to the public API via `@nearpay-money/spec` types; no secrets in the bundle.
- Strict CSP (nonces, no `unsafe-inline`); no third-party runtime scripts unless listed in ADR-0010.

## Never

- Import source code from another NearPay repo (depend on published packages/images only).
- Read or write another service's database.
- Add design documents here — update `nearpay-brain` and link to it.
- Commit secrets, private keys or real customer data.
- Merge changes to paths listed in `.github/CODEOWNERS` without the required human review.
