/**
 * Pure logic of the checkout's dropdown picker (`Picker.tsx`): filtering ("every word matches",
 * case- and accent-insensitive), keyboard movement over enabled items, and what a key press on the
 * search box or the closed trigger does. Kept free of React and the DOM so it is unit-tested in Node.
 */

export interface PickerItemBase {
  readonly value: string;
  readonly label: string;
  readonly description?: string | undefined;
  /** Extra search terms (token symbols of a network, chain ids…). */
  readonly keywords?: readonly string[] | undefined;
  readonly disabled?: boolean | undefined;
}

const norm = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/** Words of a query; "on" is ignored so "USDC on Base" works like the Figma example. */
export function queryWords(query: string): string[] {
  return norm(query)
    .split(/[\s·,/]+/)
    .filter((w) => w && w !== "on");
}

export function filterItems<T extends PickerItemBase>(items: readonly T[], query: string): T[] {
  const words = queryWords(query);
  if (words.length === 0) return [...items];
  return items.filter((i) => {
    const hay = norm([i.label, i.description ?? "", ...(i.keywords ?? [])].join(" "));
    return words.every((w) => hay.includes(w));
  });
}

export type MoveKey = "ArrowDown" | "ArrowUp" | "Home" | "End" | "PageDown" | "PageUp";

const PAGE = 5;

/**
 * Next active item for a movement key, skipping disabled items. With no active item, ArrowDown /
 * PageDown / Home start at the first enabled item, ArrowUp / PageUp / End at the last. Arrows wrap;
 * page keys stop at the ends. Returns null when nothing is enabled.
 */
export function moveActive(items: readonly PickerItemBase[], active: string | null, key: MoveKey): string | null {
  const enabled = items.filter((i) => !i.disabled);
  const n = enabled.length;
  if (n === 0) return null;
  const at = active === null ? -1 : enabled.findIndex((i) => i.value === active);
  let next: number;
  switch (key) {
    case "Home":
      next = 0;
      break;
    case "End":
      next = n - 1;
      break;
    case "ArrowDown":
      next = at === -1 ? 0 : (at + 1) % n;
      break;
    case "ArrowUp":
      next = at === -1 ? n - 1 : (at - 1 + n) % n;
      break;
    case "PageDown":
      next = at === -1 ? 0 : Math.min(at + PAGE, n - 1);
      break;
    case "PageUp":
      next = at === -1 ? n - 1 : Math.max(at - PAGE, 0);
      break;
  }
  return (enabled[next] as PickerItemBase).value;
}

/** Active item when the list opens or the filter changes: the selected value if visible and enabled, else the first enabled. */
export function initialActive(items: readonly PickerItemBase[], selected: string | null): string | null {
  if (selected !== null && items.some((i) => i.value === selected && !i.disabled)) return selected;
  return items.find((i) => !i.disabled)?.value ?? null;
}

export type SearchKeyResult =
  | { readonly type: "move"; readonly active: string | null }
  | { readonly type: "select"; readonly value: string }
  | { readonly type: "close"; readonly restoreFocus: boolean }
  | { readonly type: "clear" }
  | { readonly type: "none" };

const MOVE_KEYS = new Set<string>(["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"]);

/**
 * A key on the open picker's search box. Home/End move in the list only while the query is empty
 * (otherwise they move the caret). Esc clears a query first, then closes (focus back to the trigger);
 * Tab closes without moving focus back (the browser moves it on).
 */
export function searchKey(
  key: string,
  ctx: { readonly items: readonly PickerItemBase[]; readonly active: string | null; readonly query: string },
): SearchKeyResult {
  if (MOVE_KEYS.has(key)) {
    if ((key === "Home" || key === "End") && ctx.query !== "") return { type: "none" };
    return { type: "move", active: moveActive(ctx.items, ctx.active, key as MoveKey) };
  }
  if (key === "Enter") {
    const item = ctx.items.find((i) => i.value === ctx.active && !i.disabled);
    return item ? { type: "select", value: item.value } : { type: "none" };
  }
  if (key === "Escape") return ctx.query !== "" ? { type: "clear" } : { type: "close", restoreFocus: true };
  if (key === "Tab") return { type: "close", restoreFocus: false };
  return { type: "none" };
}

/**
 * A key on the closed trigger: ArrowDown / ArrowUp / Enter / Space open the list; a printable
 * character opens it with that character as the first letter of the search (type-to-filter).
 */
export function triggerKey(
  key: string,
  mods: { readonly ctrl?: boolean; readonly meta?: boolean; readonly alt?: boolean } = {},
): { readonly open: boolean; readonly query: string } {
  if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") return { open: true, query: "" };
  if (key.length === 1 && !mods.ctrl && !mods.meta && !mods.alt && /\S/u.test(key)) return { open: true, query: key };
  return { open: false, query: "" };
}

/** DOM id of an option: stable, CSS-safe and injective (every other character is hex-escaped). */
export function optionDomId(listId: string, value: string): string {
  return `${listId}-${value.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(16)}`)}`;
}

/** Consecutive runs of items sharing a `group` heading (items without one form runs of their own). */
export function groupRuns<T extends { readonly group?: string | undefined }>(
  items: readonly T[],
): { readonly group: string | undefined; readonly items: T[] }[] {
  const runs: { group: string | undefined; items: T[] }[] = [];
  for (const item of items) {
    const last = runs[runs.length - 1];
    if (last && last.group === item.group) last.items.push(item);
    else runs.push({ group: item.group, items: [item] });
  }
  return runs;
}
