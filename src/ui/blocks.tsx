/**
 * Checkout compositions on top of `@nearpay-internal/ui`. Only what the kit lacks lives here (listed as
 * kit gaps in the step 2.3 report): `OptionButton` (a token/wallet row that is a button, not a radio —
 * tapping it moves on), `StateScreen` (icon + title + lede + badge + callout + actions, the shape of
 * every status frame in the Figma), `CopyTextButton` (copy a short value with a polite announcement).
 */
import {
  Avatar,
  Button,
  type ButtonProps,
  Callout,
  ChevronRightIcon,
  cx,
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

/** A selectable row styled like the kit's OptionCard, as a button (tap = continue). */
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
    <button
      type="button"
      className={cx(
        "np-option",
        "ck-option-button",
        selected && "np-option--selected",
        disabled && "np-option--disabled",
        className,
      )}
      disabled={disabled}
      aria-pressed={selected === undefined ? undefined : selected}
      aria-busy={pending || undefined}
      onClick={onClick}
      data-testid={testId}
    >
      {typeof avatar === "string" ? <Avatar initial={avatar} size="sm" /> : avatar}
      <span className="np-option__text">
        <span className="np-option__title">{title}</span>
        {description ? <span className="np-option__description">{description}</span> : null}
      </span>
      <span className="np-option__indicator" aria-hidden="true">
        {pending ? <Spinner /> : disabled ? null : <ChevronRightIcon size={16} />}
      </span>
    </button>
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

/** The status frame of the Figma: divider, icon, title, lede, badge, callout with reference, actions. */
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
  return (
    <section className="ck-screen" data-testid={testId} aria-labelledby={testId ? `${testId}-title` : undefined}>
      {icon ? <hr className="np-divider" /> : null}
      <div className="np-stack">
        {icon ? <span className="np-checkout__state-icon">{icon}</span> : null}
        <h1 className="np-checkout__title" id={testId ? `${testId}-title` : undefined}>
          {title}
        </h1>
        {body ? <p className="np-checkout__lede">{body}</p> : null}
        {badge ? <StatusBadge {...(badgeTone ? { tone: badgeTone } : {})}>{badge}</StatusBadge> : null}
      </div>
      {callout ? <Callout tone={calloutTone} title={callout} reference={reference} live={live} /> : null}
      {children}
      {actions ? <div className="np-stack">{actions}</div> : null}
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
