import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import { CSP_NONCE_PLACEHOLDER, contentSecurityPolicy, resolveConfig } from "./build/config";

const root = fileURLToPath(new URL(".", import.meta.url));

// Static SPA (lld/checkout-and-js.md §2): hashed assets under /assets/, one index.html for every route
// (/c/:id, /embed/:id, /l/:id, /i/:id), strict CSP in a meta tag, build-time constants only.
export default defineConfig(({ mode }) => {
  const env = { ...process.env, ...loadEnv(mode, root, ["VITE_", "NP_"]) };
  const config = resolveConfig(env, root, mode);
  return {
    base: "/",
    publicDir: "public",
    define: {
      __NP_CONFIG__: JSON.stringify({
        apiOrigin: config.apiOrigin,
        sentinelKeys: config.sentinelKeys,
        turnstileSitekey: config.turnstileSitekey,
        walletConnectProjectId: config.walletConnectProjectId,
        nearNetwork: config.nearNetwork,
        nearRpcUrl: config.nearRpcUrl,
      }),
      __NP_E2E__: JSON.stringify(config.e2e),
    },
    esbuild: { legalComments: "none" },
    build: {
      outDir: config.e2e ? "dist-e2e" : "dist",
      emptyOutDir: true,
      sourcemap: false,
      target: "es2022",
      modulePreload: { polyfill: false },
      assetsInlineLimit: 0,
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        onwarn(warning, warn) {
          if (warning.code === "INVALID_ANNOTATION") return; // zod's comments, harmless
          warn(warning);
        },
      },
    },
    plugins: [
      {
        name: "nearpay-csp",
        transformIndexHtml(html: string) {
          return html
            .replace("%NP_CSP%", contentSecurityPolicy(config))
            .replaceAll("%NP_CSP_NONCE%", CSP_NONCE_PLACEHOLDER);
        },
      },
    ],
  };
});
