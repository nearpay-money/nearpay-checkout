/**
 * Dropdown picker (network and token in "Pay with"): one trigger showing the selected item; it opens
 * a panel anchored to it with a search box on top and a list that scrolls inside its own container
 * (max 320 px; a bottom sheet with a 60vh list below 480 px). Keyboard: type on the trigger to open
 * with a filter, arrows / Home / End / PageUp / PageDown move, Enter selects, Esc clears the search
 * then closes and returns focus to the trigger, Tab closes. A press outside closes.
 *
 * ARIA: the trigger is a button (`aria-haspopup="dialog"`) opening a non-modal panel that holds a
 * combobox (the search box) controlling a listbox (`aria-activedescendant`). Built from design-system
 * tokens and classes only (no inline styles: CSP style-src); the logic lives in `picker-model.ts`.
 */
import { Avatar, CheckIcon, ChevronDownIcon, CloseIcon, cx, SearchIcon, Skeleton } from "@nearpay-internal/ui";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  filterItems,
  groupRuns,
  initialActive,
  optionDomId,
  type PickerItemBase,
  searchKey,
  triggerKey,
} from "./picker-model";
import { useMediaQuery } from "./useMediaQuery";

export interface PickerItem extends PickerItemBase {
  /** Avatar initial (defaults to the label's first letter). */
  readonly avatar?: string | undefined;
  /** Right-aligned content, e.g. the wallet balance. */
  readonly trailing?: ReactNode;
  /** Shorter label for the closed trigger (defaults to `label`). */
  readonly triggerLabel?: string | undefined;
  /** Group heading; consecutive items with the same group are listed under it. */
  readonly group?: string | undefined;
  readonly testId?: string | undefined;
}

export interface PickerProps {
  /** Visible label above the trigger and accessible name of the panel ("Network"). */
  label: string;
  items: readonly PickerItem[];
  value: string | null;
  onChange: (value: string) => void;
  /** Trigger text when nothing is selected. */
  placeholder: string;
  /** Second line of the trigger (e.g. the balance of the selected token). */
  triggerDescription?: ReactNode;
  /** Label and placeholder of the search box. */
  searchLabel: string;
  /** Shown when the filter matches nothing (or the list is empty). */
  empty: ReactNode;
  /** Skeleton rows instead of the list (balances loading). */
  loading?: boolean;
  loadingLabel?: string;
  /** Between the search box and the list (e.g. "Couldn't load your balances"). */
  notice?: ReactNode;
  /** Under the list (e.g. "Show all tokens"). */
  footer?: ReactNode;
  /** Screen-reader count after filtering. */
  countLabel: (count: number) => string;
  /** Accessible name of the bottom sheet's close button. */
  closeLabel: string;
  disabled?: boolean;
  /** Render open initially (server rendering in tests, a picker that must be answered first). */
  defaultOpen?: boolean;
  testId: string;
  className?: string;
}

/** Below this width the panel is a bottom sheet. */
export const SHEET_QUERY = "(max-width: 479px)";

export function Picker({
  label,
  items,
  value,
  onChange,
  placeholder,
  triggerDescription,
  searchLabel,
  empty,
  loading = false,
  loadingLabel,
  notice,
  footer,
  countLabel,
  closeLabel,
  disabled = false,
  defaultOpen = false,
  testId,
  className,
}: PickerProps) {
  const auto = useId();
  const labelId = `ck-pk${auto}-label`;
  const panelId = `ck-pk${auto}-panel`;
  const listId = `ck-pk${auto}-list`;
  const inputId = `ck-pk${auto}-search`;
  const sheet = useMediaQuery(SHEET_QUERY);
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(() => (defaultOpen ? initialActive(items, value) : null));
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => filterItems(items, query), [items, query]);
  const selected = items.find((i) => i.value === value) ?? null;

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    setQuery("");
    if (restoreFocus) trigger.current?.focus();
  };
  const select = (v: string) => {
    onChange(v);
    close(true);
  };
  const openWith = (q: string) => {
    setQuery(q);
    setActive(initialActive(filterItems(items, q), value));
    setOpen(true);
  };

  // Focus the search box when the panel opens (caret after a type-to-filter character).
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  // Keep the active option visible inside the scrolling list (the first one with its group heading).
  useEffect(() => {
    if (!open || active === null) return;
    const el = document.getElementById(optionDomId(listId, active));
    const list = document.getElementById(listId);
    if (!el || !list) return;
    if (list.querySelector('[role="option"]') === el) list.scrollTop = 0;
    else el.scrollIntoView?.({ block: "nearest" });
  }, [open, active, listId]);

  // A press or focus outside closes (without pulling focus back).
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      if (root.current && e.target instanceof Node && !root.current.contains(e.target)) closeRef.current(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
    };
  }, [open]);

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (open || disabled) return;
    const r = triggerKey(e.key, { ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey });
    if (!r.open) return;
    e.preventDefault();
    openWith(r.query);
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const r = searchKey(e.key, { items: visible, active, query });
    switch (r.type) {
      case "move":
        e.preventDefault();
        setActive(r.active);
        break;
      case "select":
        e.preventDefault();
        select(r.value);
        break;
      case "clear":
        e.preventDefault();
        e.stopPropagation();
        setQuery("");
        setActive(initialActive(items, value));
        break;
      case "close":
        if (r.restoreFocus) {
          e.preventDefault();
          e.stopPropagation();
        }
        close(r.restoreFocus);
        break;
      case "none":
        break;
    }
  };

  const renderOption = (item: PickerItem) => {
    const isSelected = item.value === value;
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard is handled on the search box (aria-activedescendant)
      <div
        key={item.value}
        id={optionDomId(listId, item.value)}
        role="option"
        tabIndex={-1}
        aria-selected={isSelected}
        aria-disabled={item.disabled || undefined}
        className={cx(
          "ck-picker__option",
          isSelected && "ck-picker__option--selected",
          item.value === active && "ck-picker__option--active",
          item.disabled && "ck-picker__option--disabled",
        )}
        onClick={() => !item.disabled && select(item.value)}
        onPointerMove={() => !item.disabled && item.value !== active && setActive(item.value)}
        data-testid={item.testId}
      >
        <Avatar initial={item.avatar ?? item.label} size="sm" />
        <span className="ck-picker__text">
          <span className="ck-picker__title">{item.label}</span>
          {item.description ? <span className="ck-picker__sub">{item.description}</span> : null}
        </span>
        {item.trailing ? <span className="ck-picker__trail">{item.trailing}</span> : null}
        <span className="ck-picker__check" aria-hidden="true">
          {isSelected ? <CheckIcon size={16} /> : null}
        </span>
      </div>
    );
  };
  // Consecutive items with the same group heading form one ARIA group.
  const sections = groupRuns(visible);
  return (
    <div ref={root} className={cx("ck-picker", open && "ck-picker--open", className)} data-testid={testId}>
      <span id={labelId} className="ck-picker__label">
        {label}
      </span>
      <button
        ref={trigger}
        type="button"
        className="ck-picker__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-labelledby={`${labelId} ${labelId}-value`}
        disabled={disabled}
        onClick={() => (open ? close(false) : openWith(""))}
        onKeyDown={onTriggerKey}
        data-testid={`${testId}-trigger`}
      >
        {selected ? <Avatar initial={selected.avatar ?? selected.label} size="sm" /> : null}
        <span className="ck-picker__value" id={`${labelId}-value`}>
          <span className={cx("ck-picker__title", !selected && "ck-picker__placeholder")}>
            {selected ? (selected.triggerLabel ?? selected.label) : placeholder}
          </span>
          {selected && triggerDescription ? <span className="ck-picker__sub">{triggerDescription}</span> : null}
        </span>
        <ChevronDownIcon size={20} />
      </button>
      {open ? (
        <>
          {sheet ? <div className="ck-picker__backdrop" aria-hidden="true" onClick={() => close(true)} /> : null}
          <div
            id={panelId}
            role="dialog"
            aria-labelledby={labelId}
            className={cx("ck-picker__panel", sheet && "ck-picker__panel--sheet")}
            data-testid={`${testId}-panel`}
          >
            {sheet ? (
              <div className="ck-picker__sheet-head">
                <span className="ck-picker__sheet-title" aria-hidden="true">
                  {label}
                </span>
                <button type="button" className="ck-picker__close" aria-label={closeLabel} onClick={() => close(true)}>
                  <CloseIcon size={20} />
                </button>
              </div>
            ) : null}
            <label htmlFor={inputId} className="np-sr-only">
              {searchLabel}
            </label>
            <div className="np-input np-input--trailing ck-picker__search">
              <input
                ref={input}
                id={inputId}
                className="np-input__control"
                type="text"
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={active !== null && !loading ? optionDomId(listId, active) : undefined}
                autoComplete="off"
                spellCheck={false}
                placeholder={searchLabel}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(initialActive(filterItems(items, e.target.value), value));
                }}
                onKeyDown={onSearchKey}
                data-testid={`${testId}-search`}
              />
              <span className="np-input__adornment np-input__adornment--trailing">
                <SearchIcon size={20} />
              </span>
            </div>
            {notice ? <div className="ck-picker__notice">{notice}</div> : null}
            {loading ? (
              <div className="ck-picker__list" aria-busy="true" data-testid={`${testId}-loading`}>
                <p className="np-sr-only" role="status">
                  {loadingLabel}
                </p>
                <Skeleton shape="block" />
                <Skeleton shape="block" />
                <Skeleton shape="block" />
              </div>
            ) : (
              <div
                id={listId}
                role="listbox"
                aria-labelledby={labelId}
                className="ck-picker__list"
                data-testid={`${testId}-list`}
              >
                {sections.map((sec, i) =>
                  sec.group ? (
                    // biome-ignore lint/a11y/useSemanticElements: an option group inside a listbox (WAI-ARIA), not a form fieldset
                    <div
                      key={`g-${(sec.items[0] as PickerItem).value}`}
                      role="group"
                      aria-labelledby={`${listId}-g${i}`}
                      className="ck-picker__group"
                    >
                      <div id={`${listId}-g${i}`} className="ck-picker__group-label" role="presentation">
                        {sec.group}
                      </div>
                      {sec.items.map(renderOption)}
                    </div>
                  ) : (
                    sec.items.map(renderOption)
                  ),
                )}
              </div>
            )}
            {!loading && visible.length === 0 ? (
              <p className="ck-picker__empty" data-testid={`${testId}-empty`}>
                {empty}
              </p>
            ) : null}
            {footer ? <div className="ck-picker__footer">{footer}</div> : null}
            <div role="status" aria-live="polite" aria-atomic="true" className="np-sr-only">
              {query && !loading ? countLabel(visible.length) : ""}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
