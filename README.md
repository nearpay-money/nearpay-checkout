# nearpay-checkout

> Hosted checkout, payment links, hosted invoices and the embedded iframe app; wallet adapters; deposit instructions; live status.

| | |
|---|---|
| Group | Frontends |
| Kind | static SPA |
| Ships as | pay.nearpay.money |
| Owns | — (stateless) |
| Depends on (published artifacts only) | spec (public), gateway |
| Roadmap phase | P1 Core payments |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

- `nearpay-brain/architecture/hld.md` — system design
- `nearpay-brain/architecture/repositories.md` — repo topology and dependency rules
- `nearpay-brain/decisions/ADR-0010-checkout-isolation.md`
- `nearpay-brain/architecture/flows.md#2-checkout--cross-chain-any-asset-the-main-path`

## Layout

```
nearpay-checkout/
├── public/
├── src/
│   ├── features/
│   │   ├── asset-picker/
│   │   ├── deposit-instructions/
│   │   ├── refund-address/
│   │   ├── status-stream/
│   │   └── wallet-connect/
│   ├── lib/
│   │   ├── api/
│   │   └── integrity/
│   ├── routes/
│   │   ├── embed/
│   │   ├── invoice/
│   │   ├── payment-link/
│   │   └── session/
│   └── wallets/
│       ├── evm/
│       ├── near/
│       └── solana/
├── test/
│   ├── e2e/
│   └── unit/
└── .github/
    └── workflows/
```

## Status

Scaffold only. Implementation starts in phase **P1 Core payments** (`nearpay-brain/roadmap/roadmap.md`).
