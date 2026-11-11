#!/usr/bin/env node
/**
 * Copies the chain and token logos the checkout shows from `@web3icons/core` (MIT, devDependency) into
 * src/assets/crypto/ as plain SVG files. They are served self-hosted as hashed assets (CSP `img-src 'self'`,
 * no remote images) and cost no JavaScript; only the files listed here are bundled.
 *
 *   node scripts/sync-crypto-icons.mjs          # write the files
 *   node scripts/sync-crypto-icons.mjs --check  # exit 1 if a committed file differs from the package
 *
 * Variant "background": the logo on its brand-colour tile. The UI clips chain tiles to rounded squares and
 * token tiles to circles, so a network and a token never look alike.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(root, "node_modules/@web3icons/core/dist/svgs");
const out = join(root, "src/assets/crypto");

/** Output file name → package icon (`networks/<name>` or `tokens/<SYMBOL>`). */
export const ICONS = {
  // Chains (src/lib/chains/chains.ts). Dogecoin has no network logo in the set: the UI uses its coin logo.
  "chain-near": "networks/near-protocol",
  "chain-ethereum": "networks/ethereum",
  "chain-base": "networks/base",
  "chain-arbitrum": "networks/arbitrum-one",
  "chain-optimism": "networks/optimism",
  "chain-polygon": "networks/polygon",
  "chain-bnb": "networks/binance-smart-chain",
  "chain-avalanche": "networks/avalanche",
  "chain-gnosis": "networks/gnosis",
  "chain-solana": "networks/solana",
  "chain-bitcoin": "networks/bitcoin",
  "chain-litecoin": "networks/litecoin",
  // Tokens.
  "token-usdc": "tokens/USDC",
  "token-usdt": "tokens/USDT",
  "token-eth": "tokens/ETH",
  "token-sol": "tokens/SOL",
  "token-btc": "tokens/BTC",
  "token-near": "tokens/NEAR",
  "token-dai": "tokens/DAI",
  "token-wbtc": "tokens/WBTC",
  "token-pol": "tokens/POL",
  "token-bnb": "tokens/BNB",
  "token-avax": "tokens/AVAX",
  "token-ltc": "tokens/LTC",
  "token-doge": "tokens/DOGE",
  "token-op": "tokens/OP",
  "token-gno": "tokens/GNO",
  "token-arb": "networks/arbitrum-one",
};

async function svgOf(icon) {
  const mod = await import(pathToFileURL(join(pkg, `${icon.replace("/", "/background/")}.svg.js`)).href);
  const svg = String(mod.default).trim();
  if (!svg.startsWith("<svg") || /<script|<image|href="http|style=/i.test(svg)) throw new Error(`unexpected SVG: ${icon}`);
  return `${svg}\n`;
}

const check = process.argv.includes("--check");
let stale = 0;
await mkdir(out, { recursive: true });
for (const [name, icon] of Object.entries(ICONS)) {
  const file = join(out, `${name}.svg`);
  const svg = await svgOf(icon);
  if (check) {
    const have = await readFile(file, "utf8").catch(() => "");
    if (have !== svg) {
      stale += 1;
      console.error(`stale: ${name}.svg`);
    }
  } else {
    await writeFile(file, svg);
  }
}
if (stale) process.exit(1);
console.log(check ? "crypto icons up to date" : `wrote ${Object.keys(ICONS).length} icons to src/assets/crypto/`);
