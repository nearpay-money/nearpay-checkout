import { defineConfig } from "vitest/config";

// Unit tests run in Node against the pure modules (no DOM). The coverage gate (foundations §16) is on the
// money-path and state logic: sentinel verification, wallet transaction builders, validators, the UI
// state machine, the SSE client, the embed protocol, the build-time key pinning and the NEAR wallet manifest pinning.
export default defineConfig({
  define: {
    __NP_CONFIG__: JSON.stringify({
      apiOrigin: "/api",
      sentinelKeys: [{ kid: "sent-test-1", public_key: "LHE3Fv7ETKuSmfJWAEBI9iPLlmY5mnePtHvXygDK9GA" }],
      turnstileSitekey: "1x00000000000000000000AA",
      walletConnectProjectId: "",
      nearNetwork: "mainnet",
      nearRpcUrl: "https://rpc.test",
    }),
    __NP_E2E__: "false",
  },
  test: {
    include: ["test/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: [
        "src/lib/**/*.ts",
        "src/app/machine.ts",
        "src/app/route.ts",
        "src/features/refund-address/validate.ts",
        "src/features/deposit-instructions/qr.ts",
        "src/features/asset-picker/options.ts",
        "src/features/status-stream/*.ts",
        "src/wallets/evm/tx.ts",
        "src/wallets/near/tx.ts",
        "src/wallets/near/rpc.ts",
        "src/wallets/near/pinning.ts",
        "src/wallets/intents/*.ts",
        "src/routes/embed/protocol.ts",
        "build/config.ts",
      ],
      exclude: ["src/lib/i18n/messages.en.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { branches: 90, lines: 90 },
    },
  },
});
