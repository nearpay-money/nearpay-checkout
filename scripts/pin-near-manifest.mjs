#!/usr/bin/env node
/**
 * Pins the NEAR Connect wallet manifest (lld/checkout-and-js.md §10).
 *
 * Without a `manifest` option, @hot-labs/near-connect downloads the manifest from the mutable `main` branch
 * of hot-dao/near-selector at runtime, and the manifest's executor URLs point at mutable branches too.
 * This script takes a snapshot instead:
 *   1. resolves hot-dao/near-selector `main` (or `--commit <sha>`) to a full commit SHA (`git ls-remote`);
 *   2. reads `repository/manifest.json` at that commit;
 *   3. rewrites every raw.githubusercontent.com URL (executors and icons) from a branch to the commit SHA the
 *      branch points at now (each repo resolved with `git ls-remote`);
 *   4. drops wallets whose executor is not on GitHub (no commit to pin);
 *   5. downloads every pinned executor and records its SRI hash (sha384), which the app passes to `fetch`
 *      so the browser refuses any other bytes;
 *   6. writes the snapshot to OUT as TypeScript and formats it with Biome.
 *
 * Usage: node scripts/pin-near-manifest.mjs [--commit <40-hex sha>] [--out <path>]
 * Then review every executor diff between the old and the new commits, run `pnpm verify` and commit.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = "src/wallets/near/manifest.ts";
const SELECTOR_REPO = "hot-dao/near-selector";
const MANIFEST_PATH = "repository/manifest.json";
const RAW = "https://raw.githubusercontent.com/";
const SHA = /^[0-9a-f]{40}$/;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const out = resolve(ROOT, arg("--out") ?? DEFAULT_OUT);
const wantedCommit = arg("--commit");
if (wantedCommit !== undefined && !SHA.test(wantedCommit)) throw new Error("--commit must be a full 40-hex SHA");

/** `git ls-remote` of a GitHub repo → Map(ref name → commit SHA); annotated tags resolve to their commit. */
const refsCache = new Map();
function remoteRefs(repo) {
  if (refsCache.has(repo)) return refsCache.get(repo);
  const text = execFileSync("git", ["ls-remote", "--heads", "--tags", `https://github.com/${repo}`], {
    encoding: "utf8",
  });
  const refs = new Map();
  for (const line of text.trim().split("\n")) {
    const [sha, ref] = line.split("\t");
    if (!sha || !ref) continue;
    const name = ref.replace(/^refs\/(heads|tags)\//, "").replace(/\^\{\}$/, "");
    // `tag^{}` (the peeled commit) comes after `tag` and wins; branches take precedence over tags.
    if (ref.endsWith("^{}") || !refs.has(name) || ref.startsWith("refs/heads/")) refs.set(name, sha);
  }
  refsCache.set(repo, refs);
  return refs;
}

/**
 * A raw.githubusercontent.com URL on a branch or tag → the same file at the commit the ref points at now.
 * Branch names may contain "/", so the longest ref that prefixes the path wins.
 */
function pinRawUrl(url) {
  if (!url.startsWith(RAW)) return null;
  const [owner, repo, ...rest] = url.slice(RAW.length).split("/");
  const repoName = `${owner}/${repo}`;
  if (SHA.test(rest[0] ?? ""))
    return { url, repo: repoName, ref: rest[0], commit: rest[0], path: rest.slice(1).join("/") };
  const tail = rest.join("/").replace(/^refs\/(heads|tags)\//, "");
  let best = null;
  for (const [name, sha] of remoteRefs(repoName)) {
    if (tail.startsWith(`${name}/`) && (!best || name.length > best.name.length)) best = { name, sha };
  }
  if (!best) throw new Error(`cannot resolve the ref of ${url}`);
  const path = tail.slice(best.name.length + 1);
  return { url: `${RAW}${repoName}/${best.sha}/${path}`, repo: repoName, ref: best.name, commit: best.sha, path };
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const selectorCommit = wantedCommit ?? remoteRefs(SELECTOR_REPO).get("main");
if (!selectorCommit) throw new Error(`cannot resolve ${SELECTOR_REPO} main`);
const source = `${RAW}${SELECTOR_REPO}/${selectorCommit}/${MANIFEST_PATH}`;
const upstream = JSON.parse((await download(source)).toString("utf8"));

const wallets = [];
const pins = [];
const excluded = {};
const integrity = {};
for (const wallet of upstream.wallets) {
  const pinned = pinRawUrl(wallet.executor);
  if (wallet.type !== "sandbox" || !pinned) {
    excluded[wallet.id] = `executor ${wallet.executor} is not on GitHub and cannot be commit-pinned`;
    continue;
  }
  const icon = pinRawUrl(wallet.icon)?.url ?? wallet.icon;
  const bytes = await download(pinned.url);
  if (!Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) {
    console.warn(`! ${wallet.id}: executor is not clean UTF-8; cached copies will be re-downloaded`);
  }
  integrity[pinned.url] ??= `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
  wallets.push({ ...wallet, icon, executor: pinned.url });
  pins.push({ id: wallet.id, ...pinned, bytes: bytes.length });
  console.log(
    `  ${wallet.id.padEnd(16)} ${pinned.repo}@${pinned.commit.slice(0, 12)} ${pinned.path} (${bytes.length} B)`,
  );
}
for (const [id, why] of Object.entries(excluded)) console.log(`- ${id}: ${why}`);

const today = new Date().toISOString().slice(0, 10);
const pinLines = pins.map((p) => ` *   ${p.id.padEnd(16)} ${p.repo}@${p.commit} (was ${p.ref}) ${p.path}`);
const excludedLines = Object.entries(excluded).map(([id, why]) => ` *   ${id}: ${why}`);
const ts = `/**
 * GENERATED by scripts/pin-near-manifest.mjs on ${today}. Do not edit by hand.
 *
 * Reviewed snapshot of the NEAR Connect wallet manifest, passed to \`NearConnector\` as the \`manifest\` object so
 * nothing is downloaded from a mutable branch at runtime (lld/checkout-and-js.md §10).
 *
 * Source:  ${source}
 *          (${SELECTOR_REPO} \`main\` at commit ${selectorCommit}, manifest version ${upstream.version})
 * Pinned:  ${today}
 * Executors, each at a full commit SHA; NEAR Connect fetches them as text and runs them in a sandboxed
 * \`srcdoc\` iframe, and the app makes the browser check each response against NEAR_EXECUTOR_INTEGRITY:
${pinLines.join("\n")}
 * Left out:
${excludedLines.length ? excludedLines.join("\n") : " *   (none)"}
 *
 * Refresh: \`node scripts/pin-near-manifest.mjs\` (pins \`main\` HEAD; \`--commit <sha>\` pins a given commit), review
 * the diff of every executor between the old and the new commits, run \`pnpm verify\`, commit.
 */

/** A wallet entry as the manifest has it (the library's \`WalletManifest\` type mistypes \`platform\`). */
export interface PinnedWalletManifest {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly version: string;
  readonly executor: string;
  readonly type: "sandbox";
  readonly [key: string]: unknown;
}

export const NEAR_SELECTOR_COMMIT = ${JSON.stringify(selectorCommit)};
export const NEAR_MANIFEST_SOURCE = ${JSON.stringify(source)};
export const NEAR_MANIFEST_PINNED_AT = ${JSON.stringify(today)};

/** Wallets of the upstream manifest left out of the snapshot, with the reason. */
export const NEAR_EXCLUDED_WALLETS: Readonly<Record<string, string>> = ${JSON.stringify(excluded, null, 2)};

/** Executor URL → Subresource Integrity hash of the reviewed file. */
export const NEAR_EXECUTOR_INTEGRITY: Readonly<Record<string, string>> = ${JSON.stringify(integrity, null, 2)};

export const PINNED_NEAR_MANIFEST: { readonly version: string; readonly wallets: readonly PinnedWalletManifest[] } = ${JSON.stringify(
  { version: upstream.version, wallets },
  null,
  2,
)};
`;
writeFileSync(out, ts);
try {
  execFileSync("pnpm", ["exec", "biome", "format", "--write", out], { cwd: ROOT, stdio: "ignore" });
} catch {
  console.warn("! could not run Biome; run `pnpm format` before committing");
}
console.log(`wrote ${relative(ROOT, out)} (${wallets.length} wallets, ${SELECTOR_REPO}@${selectorCommit})`);
