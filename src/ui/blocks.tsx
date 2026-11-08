/**
 * Checkout compositions on top of `@nearpay-internal/ui`. Since ui 0.3.0 `OptionButton` and `StateScreen`
 * are thin wrappers over the kit components (adding the checkout-only states the kit lacks);
 * `CopyTextButton` (copy a short value as a full-width button with a polite announcement) stays local.
 */
import {
  Button,
  type ButtonProps,
  Callout,
  cx,
  OptionButton as KitOptionButton,
  StateScreen as KitStateScreen,
  LiveRegion,
  Spinner,
  StatusBadge,
  type Tone,
} from "@nearpay-internal/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";

export interface OptionButtonProps {
  title: ReactNode;
  description?: ReactNode;
  /** Avatar initial ("U" for USDC) or a custom node (wallet icon). */
  avatar?: ReactNode;
  disabled?: boolean;
  selected?: boolean;
  /** Shows a spinner instead of the chevron (connecting, preparing). */
  pending?: boolean;
  onClick?: () => void;
  testId?: string;
  className?: string;
}

/**
 * A token/wallet row that is a button (tap = continue): the kit's `OptionButton` (ui 0.3.0) plus the
 * checkout's selected / pending / disabled states (kit gap: no `selected` or `pending` props).
 */
export function OptionButton({
  title,
  description,
  avatar,
  disabled,
  selected,
  pending,
  onClick,
  testId,
  className,
}: OptionButtonProps) {
  return (
    <KitOptionButton
      title={title}
      description={description}
      avatar={avatar}
      trailing={pending ? <Spinner /> : disabled ? <span /> : undefined}
      className={cx(selected && "np-option--selected", disabled && "np-option--disabled", className)}
      disabled={disabled}
      aria-pressed={selected === undefined ? undefined : selected}
      aria-busy={pending || undefined}
      onClick={onClick}
      data-testid={testId}
    />
  );
}

export interface StateScreenProps {
  icon?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  badge?: string;
  badgeTone?: Tone;
  callout?: ReactNode;
  calloutTone?: Tone;
  /** "Reference pi_… · Acme GmbH". */
  reference?: ReactNode;
  /** Content between the callout and the actions (amount rows). */
  children?: ReactNode;
  actions?: ReactNode;
  testId?: string;
  /** Status screens announce their callout politely (never moving focus). */
  live?: boolean;
}

/**
 * The status frame of the Figma (divider, icon, title, lede, badge, callout with reference, actions) on
 * the kit's `StateScreen` (ui 0.3.0); adds the divider under the amount hero and content between the
 * callout and the actions (kit gap: no slot there).
 */
export function StateScreen({
  icon,
  title,
  body,
  badge,
  badgeTone,
  callout,
  calloutTone = "info",
  reference,
  children,
  actions,
  testId,
  live = true,
}: StateScreenProps) {
  const titleId = testId ? `${testId}-title` : undefined;
  return (
    <section className="ck-screen" data-testid={testId} aria-labelledby={titleId}>
      {icon ? <hr className="np-divider" /> : null}
      <KitStateScreen
        icon={icon}
        title={<span id={titleId}>{title}</span>}
        badge={badge ? <StatusBadge {...(badgeTone ? { tone: badgeTone } : {})}>{badge}</StatusBadge> : undefined}
        callout={
          callout || children ? (
            <>
              {callout ? <Callout tone={calloutTone} title={callout} reference={reference} live={live} /> : null}
              {children}
            </>
          ) : undefined
        }
        actions={actions}
        live={live}
      >
        {body}
      </KitStateScreen>
    </section>
  );
}

/** A screen title + lede (flow screens without the status icon). */
export function ScreenTitle({ title, lede, id }: { title: ReactNode; lede?: ReactNode; id?: string }) {
  return (
    <div className="np-stack">
      <h1 className="np-checkout__title" id={id}>
        {title}
      </h1>
      {lede ? <p className="np-checkout__lede">{lede}</p> : null}
    </div>
  );
}

/** Copies a value; the result is announced politely; on failure the value is spelled out. */
export function CopyTextButton({
  value,
  label,
  copiedLabel,
  failedLabel,
  variant = "primary",
  testId,
}: {
  value: string;
  label: string;
  copiedLabel: string;
  failedLabel: string;
  variant?: ButtonProps["variant"];
  testId?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
    timer.current = setTimeout(() => setState("idle"), 4000);
  };
  return (
    <>
      <Button fullWidth variant={variant} onClick={() => void copy()} data-testid={testId}>
        {state === "copied" ? copiedLabel : label}
      </Button>
      <LiveRegion visible={state === "failed"} className={state === "failed" ? "np-checkout__note" : undefined}>
        {state === "copied" ? copiedLabel : state === "failed" ? failedLabel : ""}
      </LiveRegion>
    </>
  );
}
