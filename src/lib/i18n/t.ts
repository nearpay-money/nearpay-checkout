import { en, type MessageKey } from "./messages.en";

/** Catalogs registered by lazy chunks (e.g. the invoice page's auto-pay copy). */
const extra: Record<string, string> = {};

export function registerMessages(messages: Readonly<Record<string, string>>): void {
  Object.assign(extra, messages);
}

/** Looks up a message and substitutes `{name}` placeholders. Unknown keys fall back to the key itself. */
export function t(key: MessageKey, vars: Record<string, string | number> = {}): string {
  const template: string = (en as Record<string, string>)[key] ?? extra[key] ?? key;
  return template.replace(/\{([a-zA-Z_]+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Message for an API / UI error code (falls back to the generic message). */
export function errorText(code: string): string {
  const key = `error.${code}` as MessageKey;
  return key in en ? t(key) : t("error.generic");
}

export function hasMessage(key: string): key is MessageKey {
  return key in en;
}
