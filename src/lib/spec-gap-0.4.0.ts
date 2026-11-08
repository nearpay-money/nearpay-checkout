/**
 * PLACEHOLDER for `@nearpay/spec` 0.4.0 (Stage 4, step 4.3 Phase A). Copied from the spec sources on
 * `stage-4/4.1-contracts` (`src/common/chains.ts`, `src/public/mandates.ts`, `src/public/invoices.ts`,
 * `src/vault/contract.ts`) using only spec 0.3.1 building blocks. Everything Stage 4 needs from the
 * contract that 0.3.1 lacks lives here and nowhere else.
 *
 * Phase B (spec 0.4.0 published): bump `@nearpay/spec`, replace the imports of this module with
 * `@nearpay/spec` (same names), delete this file and `test/fixtures/spec-0.4.0/`.
 */
import {
  AssetId,
  BaseUnits,
  getPublicInvoice as getPublicInvoice031,
  InvoiceSecretHeaders,
  id,
  inp,
  Livemode,
  NearAccountId,
  openEnum,
  out,
  PublicInvoice as PublicInvoice031,
  type RouteDefinition,
  route,
  UnixTime,
  z,
} from "@nearpay/spec";

// ---- common/chains.ts ---------------------------------------------------------------------------

/** CAIP-2 id of Solana mainnet. */
export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;
/** CAIP-2 id of Bitcoin mainnet. */
export const BITCOIN_MAINNET = "bip122:000000000019d6689c085ae165831e93" as const;

/** Exact decimal of base units (no exponent, no float, trailing zeros trimmed). */
export function formatBaseUnits(amount: string, decimals: number): string {
  if (!/^(0|[1-9][0-9]*)$/.test(amount)) throw new RangeError(`not a base-unit integer string: ${amount}`);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new RangeError(`bad decimals: ${decimals}`);
  if (decimals === 0) return amount;
  const padded = amount.padStart(decimals + 1, "0");
  const int = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

/** BIP-21 `bitcoin:<address>?amount=<BTC>` (amount from satoshis, exact). */
export function bip21Uri(address: string, amountSats: string): string {
  return `bitcoin:${address}?amount=${formatBaseUnits(amountSats, 8)}`;
}

/** Solana Pay transfer request `solana:<recipient>?amount=<decimal>[&spl-token=<mint>]` (no reference/memo). */
export function solanaPayUri(recipient: string, amountBase: string, decimals: number, splMint: string | null): string {
  const amount = formatBaseUnits(amountBase, decimals);
  return `solana:${recipient}?amount=${amount}${splMint ? `&spl-token=${splMint}` : ""}`;
}

/** Parsed omft bridge asset id `nep141:<blockchain>[-<token>].omft.near`. */
export interface OmftAsset {
  readonly blockchain: string;
  /** `native`; `evm` (ERC-20 `0x…`); `hash20` (Solana SPL: hex(keccak256(mint)[12..32])). */
  readonly kind: "native" | "evm" | "hash20";
  readonly token: string | null;
}

export function parseOmftAssetId(assetId: string): OmftAsset | null {
  const m = /^nep141:([a-z0-9]+)(?:-(0x[0-9a-f]{40}|[0-9a-f]{40}))?\.omft\.near$/.exec(assetId);
  if (!m) return null;
  const blockchain = m[1] as string;
  const token = m[2] ?? null;
  if (token === null) return { blockchain, kind: "native", token: null };
  return { blockchain, kind: token.startsWith("0x") ? "evm" : "hash20", token };
}

// ---- vault/contract.ts (the parts the payer UI checks) -----------------------------------------------

const tgas = (n: number) => (BigInt(n) * 1_000_000_000_000n).toString();

/** Gas rules (contracts-vault §3.3–§3.4) as gas-unit decimal strings. */
export const VAULT_GAS = {
  min_exit: tgas(50),
  exit: tgas(100),
  ft_transfer_call: tgas(100),
  storage_deposit: tgas(30),
} as const;

export const ONE_YOCTO = "1" as const;

/** Every stable vault error string (contract `errors::ALL`). */
export const VAULT_ERRORS = [
  "ERR_NOT_FOUND",
  "ERR_NOT_ACTIVE",
  "ERR_NOT_DUE",
  "ERR_IN_FLIGHT",
  "ERR_INSUFFICIENT_BALANCE",
  "ERR_MAX_PERIODS",
  "ERR_UNAUTHORIZED",
  "ERR_TOKEN_NOT_ALLOWED",
  "ERR_BAD_MSG",
  "ERR_CAP_EXCEEDED",
  "ERR_FEE_TOO_HIGH",
  "ERR_NO_STORAGE",
  "ERR_STILL_ACTIVE",
  "ERR_OPEN_MANDATES",
  "ERR_BAD_CONFIG",
  "ERR_UNSUPPORTED_SENDER",
  "ERR_GAS",
] as const;
export type VaultErrorCode = (typeof VAULT_ERRORS)[number];

/** First known `ERR_…` code in a log line / panic message; null when none. */
export function vaultErrorCodeOf(text: string): VaultErrorCode | null {
  for (const m of text.matchAll(/ERR_[A-Z_]+/g)) {
    const code = m[0];
    if ((VAULT_ERRORS as readonly string[]).includes(code)) return code as VaultErrorCode;
  }
  return null;
}

/** Field order NearPay writes in `create_mandate` (the contract's struct order). */
export const VAULT_CREATE_MANDATE_FIELDS = [
  "merchant_receiver",
  "receiver_kind",
  "amount_per_period",
  "period_secs",
  "start_at",
  "max_periods",
  "fee_bps",
  "ext_ref",
] as const;

export const VAULT_PERIOD_SECS_PER_INTERVAL = {
  day: 86_400,
  week: 604_800,
  month: 2_629_746,
  year: 31_556_952,
} as const;

const U128 = z.string().regex(/^(0|[1-9][0-9]{0,38})$/);
const U64Ns = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const MandateIdNum = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

export const VaultReceiverKind = z.enum(["intents_account", "near_account"]);

const VaultCreateMandateArgs = z.strictObject({
  merchant_receiver: NearAccountId,
  receiver_kind: VaultReceiverKind,
  amount_per_period: U128,
  period_secs: z.int().min(86_400).max(379_468_800),
  start_at: U64Ns.nullable().optional(),
  max_periods: z.int().min(1).max(2_147_483_647).nullable().optional(),
  fee_bps: z.int().min(0).max(10_000),
  ext_ref: z
    .string()
    .max(64)
    .regex(/^[\x20-\x7e]*$/),
});

/** The `msg` of the payer's `ft_transfer_call` to the vault: exactly one of `create_mandate`, `top_up`. */
export const VaultMsg = z.union([
  z.strictObject({ create_mandate: VaultCreateMandateArgs }),
  z.strictObject({ top_up: z.strictObject({ mandate_id: MandateIdNum }) }),
]);
export type VaultMsg = z.infer<typeof VaultMsg>;

// ---- public/mandates.ts ---------------------------------------------------------------------------

const GasUnits = z.string().regex(/^[1-9][0-9]{0,17}$/);
const Yocto = z.string().regex(/^(0|[1-9][0-9]{0,38})$/);

export const NearFunctionCallAction = out({
  type: z.literal("FunctionCall"),
  method_name: z.string().min(1).max(256),
  args: z.record(z.string(), z.unknown()),
  gas: GasUnits,
  deposit: Yocto,
});

export const NearTransactionRequest = out({
  signer_id: NearAccountId.nullable(),
  receiver_id: NearAccountId,
  actions: z.array(NearFunctionCallAction).min(1).max(4),
});
export type NearTransactionRequest = z.infer<typeof NearTransactionRequest>;

export const MandateStatus = openEnum(["active", "insufficient", "exhausted", "canceled"], "Mandate status.");
export const MandateLinkStatus = openEnum(["linked", "unlinked"], "Mandate link status.");

/** Default `payer_notice` billing returns (UIs may localise it without weakening it). */
export const MANDATE_FUNDING_PAYER_NOTICE =
  "Sign both transactions from your own NEAR account and pay the gas yourself. Relayer or gasless wallets, NEAR Intents balances, bridges and smart wallets cannot fund a mandate: the vault refunds such deposits. You can cancel at any time from any NEAR wallet and get the remaining balance back.";

export const MandateFundingInstructions = out({
  object: z.literal("mandate_funding_instructions"),
  livemode: Livemode,
  subscription: id("sub"),
  vault_contract: NearAccountId,
  token: NearAccountId,
  asset_id: AssetId,
  amount: BaseUnits,
  periods: z.int().min(1),
  amount_per_period: BaseUnits,
  period_secs: z.int().min(86_400),
  start_at: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,19})$/)
    .nullable(),
  fee_bps: z.int().min(0).max(10_000),
  merchant_receiver: NearAccountId,
  receiver_kind: VaultReceiverKind,
  settlement_destination: id("sd"),
  ext_ref: z.string().max(64),
  msg: z.string().max(2048),
  payer: NearAccountId.nullable(),
  storage: out({
    payer_registered: z.boolean().nullable(),
    deposit: z.string().regex(/^(0|[1-9][0-9]{0,38})$/),
  }),
  payer_notice: z.string(),
  transactions: z.array(NearTransactionRequest).min(1).max(2),
});
export type MandateFundingInstructions = z.infer<typeof MandateFundingInstructions>;

export const PublicMandate = out({
  id: id("md"),
  object: z.literal("mandate"),
  livemode: Livemode,
  status: MandateStatus,
  link_status: MandateLinkStatus,
  payer: NearAccountId,
  vault_contract: NearAccountId,
  onchain_id: z.int().min(0),
  token: NearAccountId,
  asset_id: AssetId,
  amount_per_period: BaseUnits,
  period_secs: z.int().min(86_400),
  balance: BaseUnits,
  funded_periods: z.int().min(0),
  collected_periods: z.int().min(0),
  next_collect_at: UnixTime.nullable(),
  collecting: z.boolean(),
  top_up_msg: z.string().nullable(),
  transactions: out({
    cancel: NearTransactionRequest.nullable(),
    withdraw: NearTransactionRequest.nullable(),
  }),
});
export type PublicMandate = z.infer<typeof PublicMandate>;

const FundingBody = {
  payer: NearAccountId.optional(),
  token: NearAccountId.optional(),
  periods: z.int().min(1).max(36).optional(),
};

const PublicInvoiceParams = inp({ id: id("in") });

/** `route()` of spec 0.3.1 with the Stage 4 error codes (not in the 0.3.1 catalogue type). */
function gapRoute<P extends z.ZodType, B extends z.ZodType | undefined, R extends z.ZodType>(
  def: Omit<RouteDefinition, "params" | "body" | "response" | "errors"> & {
    readonly params: P;
    readonly body?: B;
    readonly response: R;
    readonly errors: readonly string[];
  },
): RouteDefinition<P, undefined, B, R> {
  return route(def as never) as unknown as RouteDefinition<P, undefined, B, R>;
}

export const createPublicInvoiceMandateFunding = gapRoute({
  id: "createPublicInvoiceMandateFunding",
  method: "POST",
  path: "/v1/invoices/{id}/public/mandate_funding",
  service: "billing",
  visibility: "public",
  summary: "Hosted invoice page: compute the payer's auto-debit funding transactions.",
  auth: ["anonymous"],
  idempotent: false,
  params: PublicInvoiceParams,
  headers: InvoiceSecretHeaders,
  body: inp(FundingBody),
  response: MandateFundingInstructions,
  status: 200,
  errors: [
    "invoice_secret_invalid",
    "invoice_not_payable",
    "state_conflict",
    "auto_debit_unavailable",
    "destination_not_intents_account",
    "vault_cap_exceeded",
    "account_not_live",
    "rail_unavailable",
  ],
  stage: 4,
});

export const getPublicInvoiceMandate = gapRoute({
  id: "getPublicInvoiceMandate",
  method: "GET",
  path: "/v1/invoices/{id}/public/mandate",
  service: "billing",
  visibility: "public",
  summary: "Hosted invoice page: the subscription's mandate with the payer's cancel/withdraw transactions.",
  auth: ["anonymous"],
  idempotent: false,
  params: PublicInvoiceParams,
  headers: InvoiceSecretHeaders,
  response: PublicMandate,
  status: 200,
  errors: ["invoice_secret_invalid"],
  stage: 4,
});

// ---- public/invoices.ts: `PublicInvoice.auto_debit` --------------------------------------------------

export const PublicInvoiceAutoDebit = out({
  available: z.boolean(),
  mandate: id("md").nullable(),
  collecting: z.boolean(),
});

export const PublicInvoice = PublicInvoice031.extend({
  auto_debit: PublicInvoiceAutoDebit.nullable().optional(),
});

/** `getPublicInvoice` parsing the 0.4.0 response (with `auto_debit`). */
export const getPublicInvoice = Object.freeze({
  ...getPublicInvoice031,
  response: PublicInvoice,
}) as unknown as Omit<typeof getPublicInvoice031, "response"> & { readonly response: typeof PublicInvoice };
