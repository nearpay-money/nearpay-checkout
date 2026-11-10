/** Dropdown picker (network / token in "Pay with"): filtering, keyboard model, ARIA and scroll container markup. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Picker, type PickerItem, type PickerProps, SHEET_QUERY } from "../../src/ui/Picker";
import {
  filterItems,
  groupRuns,
  initialActive,
  moveActive,
  optionDomId,
  queryWords,
  searchKey,
  triggerKey,
} from "../../src/ui/picker-model";

const NETS: PickerItem[] = [
  { value: "eip155:8453", label: "Base", description: "USDC, ETH", keywords: ["USDC", "ETH"] },
  { value: "eip155:1", label: "Ethereum", description: "Too slow", disabled: true },
  { value: "eip155:137", label: "Polygon", keywords: ["POL"] },
  { value: "near:mainnet", label: "NEAR", keywords: ["wNEAR"] },
  { value: "solana", label: "Sōlana" },
];

describe("filterItems", () => {
  it("matches every word against label, description and keywords, case- and accent-insensitive", () => {
    expect(filterItems(NETS, "").map((i) => i.value)).toHaveLength(5);
    expect(filterItems(NETS, "  ").length).toBe(5);
    expect(filterItems(NETS, "usdc").map((i) => i.label)).toEqual(["Base"]);
    expect(filterItems(NETS, "POL").map((i) => i.label)).toEqual(["Polygon"]);
    expect(filterItems(NETS, "solana").map((i) => i.label)).toEqual(["Sōlana"]);
    expect(filterItems(NETS, "eth on base").map((i) => i.label)).toEqual(["Base"]);
    expect(filterItems(NETS, "USDC · Base").map((i) => i.label)).toEqual(["Base"]);
    expect(filterItems(NETS, "doge")).toEqual([]);
    expect(queryWords("USDC on Base")).toEqual(["usdc", "base"]);
  });
  it("returns a copy (never the caller's array)", () => {
    expect(filterItems(NETS, "")).not.toBe(NETS);
  });
});

describe("keyboard model", () => {
  it("moves over enabled items only, wrapping with arrows, clamping with page keys", () => {
    expect(moveActive(NETS, null, "ArrowDown")).toBe("eip155:8453");
    expect(moveActive(NETS, null, "ArrowUp")).toBe("solana");
    expect(moveActive(NETS, "eip155:8453", "ArrowDown")).toBe("eip155:137"); // skips disabled Ethereum
    expect(moveActive(NETS, "eip155:137", "ArrowUp")).toBe("eip155:8453");
    expect(moveActive(NETS, "solana", "ArrowDown")).toBe("eip155:8453"); // wraps
    expect(moveActive(NETS, "eip155:8453", "ArrowUp")).toBe("solana");
    expect(moveActive(NETS, "near:mainnet", "Home")).toBe("eip155:8453");
    expect(moveActive(NETS, "eip155:8453", "End")).toBe("solana");
    expect(moveActive(NETS, "eip155:8453", "PageDown")).toBe("solana");
    expect(moveActive(NETS, "solana", "PageUp")).toBe("eip155:8453");
    expect(moveActive(NETS, null, "PageDown")).toBe("eip155:8453");
    expect(moveActive(NETS, null, "PageUp")).toBe("solana");
    expect(moveActive(NETS, "gone", "ArrowDown")).toBe("eip155:8453");
    expect(moveActive([{ value: "x", label: "X", disabled: true }], null, "ArrowDown")).toBeNull();
  });
  it("starts on the selected item when it is visible and enabled, else the first enabled", () => {
    expect(initialActive(NETS, "eip155:137")).toBe("eip155:137");
    expect(initialActive(NETS, "eip155:1")).toBe("eip155:8453");
    expect(initialActive(NETS, null)).toBe("eip155:8453");
    expect(initialActive([], "x")).toBeNull();
  });
  it("search box keys: move, Enter selects the active enabled item, Esc clears then closes, Tab closes", () => {
    const ctx = { items: NETS, active: "eip155:8453", query: "" };
    expect(searchKey("ArrowDown", ctx)).toEqual({ type: "move", active: "eip155:137" });
    expect(searchKey("End", ctx)).toEqual({ type: "move", active: "solana" });
    expect(searchKey("Home", { ...ctx, query: "b" })).toEqual({ type: "none" }); // caret movement while typing
    expect(searchKey("Enter", ctx)).toEqual({ type: "select", value: "eip155:8453" });
    expect(searchKey("Enter", { ...ctx, active: "eip155:1" })).toEqual({ type: "none" });
    expect(searchKey("Enter", { ...ctx, active: null })).toEqual({ type: "none" });
    expect(searchKey("Escape", { ...ctx, query: "ba" })).toEqual({ type: "clear" });
    expect(searchKey("Escape", ctx)).toEqual({ type: "close", restoreFocus: true });
    expect(searchKey("Tab", ctx)).toEqual({ type: "close", restoreFocus: false });
    expect(searchKey("a", ctx)).toEqual({ type: "none" });
  });
  it("trigger keys open the list; a printable character opens it filtered (type-to-filter)", () => {
    for (const k of ["ArrowDown", "ArrowUp", "Enter", " "]) expect(triggerKey(k)).toEqual({ open: true, query: "" });
    expect(triggerKey("b")).toEqual({ open: true, query: "b" });
    expect(triggerKey("é")).toEqual({ open: true, query: "é" });
    expect(triggerKey("b", { ctrl: true })).toEqual({ open: false, query: "" });
    expect(triggerKey("v", { meta: true })).toEqual({ open: false, query: "" });
    expect(triggerKey("x", { alt: true })).toEqual({ open: false, query: "" });
    expect(triggerKey("Tab")).toEqual({ open: false, query: "" });
    expect(triggerKey("Escape")).toEqual({ open: false, query: "" });
  });
  it("option ids are CSS-safe and distinct for distinct values", () => {
    const a = optionDomId("l", "route_quote:nep141:usdc.near:near:mainnet");
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(optionDomId("l", "a:b")).not.toBe(optionDomId("l", "a_b"));
  });
  it("groups consecutive items under their heading", () => {
    const runs = groupRuns([
      { v: 1, group: "Popular" },
      { v: 2, group: "Popular" },
      { v: 3, group: "More" },
      { v: 4 },
      { v: 5, group: "More" },
    ]);
    expect(runs.map((r) => [r.group, r.items.length])).toEqual([
      ["Popular", 2],
      ["More", 1],
      [undefined, 1],
      ["More", 1],
    ]);
  });
});

const props = (over: Partial<PickerProps> = {}): PickerProps => ({
  label: "Network",
  items: NETS,
  value: "eip155:8453",
  onChange: () => undefined,
  placeholder: "Choose a network",
  searchLabel: "Search networks",
  empty: "No matching networks",
  countLabel: (n) => `${n} networks`,
  closeLabel: "Close list",
  testId: "network-picker",
  ...over,
});
const html = (p: PickerProps) => renderToStaticMarkup(createElement(Picker, p));

describe("Picker markup", () => {
  it("closed: one labelled trigger showing the selection, no list in the page", () => {
    const out = html(props());
    expect(out).toContain('aria-haspopup="dialog"');
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain(">Base<");
    expect(out).not.toContain('role="listbox"');
    expect(html(props({ value: null }))).toContain("Choose a network");
    expect(html(props({ items: [{ value: "x", label: "USDC · 12.34", triggerLabel: "USDC" }], value: "x" }))).toContain(
      ">USDC<",
    );
  });
  it("open: search combobox controlling a listbox inside the scroll container; disabled and selected states", () => {
    const out = html(props({ defaultOpen: true }));
    expect(out).toContain('aria-expanded="true"');
    expect(out).toMatch(/role="combobox"[^>]*aria-controls="([^"]+)"/);
    const listId = /role="combobox"[^>]*aria-controls="([^"]+)"/.exec(out)?.[1] as string;
    // The listbox IS the scrolling container (.ck-picker__list: max-height + overflow-y in styles.css).
    expect(out).toMatch(new RegExp(`id="${listId}" role="listbox"[^>]*class="ck-picker__list"`));
    expect(out).toContain(`aria-activedescendant="${optionDomId(listId, "eip155:8453")}"`);
    expect((out.match(/role="option"/g) ?? []).length).toBe(5);
    expect(out).toMatch(/aria-selected="true"[^>]*class="ck-picker__option ck-picker__option--selected/);
    expect(out).toContain('aria-disabled="true"');
    expect(out).not.toContain("ck-picker__panel--sheet"); // sheet only below 480 px
    expect(SHEET_QUERY).toBe("(max-width: 479px)");
  });
  it("open: groups, trailing balance, footer, notice; empty and loading states", () => {
    const grouped = html(
      props({
        defaultOpen: true,
        items: [
          { value: "a", label: "Base", group: "Popular", trailing: "12.34" },
          { value: "b", label: "Gnosis", group: "More networks" },
        ],
        value: "a",
        footer: "Show all tokens",
        notice: "Balances unavailable",
      }),
    );
    expect(grouped).toContain('role="group"');
    expect(grouped).toContain("Popular");
    expect(grouped).toContain('class="ck-picker__trail">12.34');
    expect(grouped).toContain("Show all tokens");
    expect(grouped).toContain("Balances unavailable");
    expect(html(props({ defaultOpen: true, items: [] }))).toContain("No matching networks");
    const loading = html(props({ defaultOpen: true, loading: true, loadingLabel: "Checking your balances…" }));
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain("Checking your balances…");
    expect(loading).not.toContain('role="listbox"');
  });
  it("styles keep the list scrolling inside a 320 px panel (60vh in the phone sheet)", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("../../src/styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.ck-picker__list \{[^}]*max-height: 320px;[^}]*overflow-y: auto;/);
    expect(css).toMatch(/\.ck-picker__panel--sheet \.ck-picker__list \{[^}]*max-height: 60vh;/);
  });
});
