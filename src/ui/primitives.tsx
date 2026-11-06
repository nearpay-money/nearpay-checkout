import type { ReactNode } from "react";

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  kind?: "primary" | "secondary" | "link";
  type?: "button" | "submit";
  testId?: string;
}) {
  return (
    <button
      type={props.type ?? "button"}
      className={`np-btn np-btn-${props.kind ?? "primary"}`}
      onClick={props.onClick}
      disabled={props.disabled}
      data-testid={props.testId}
    >
      {props.children}
    </button>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="np-spinner" role="status" aria-live="polite">
      <span className="np-spinner-dot" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function Notice({
  kind,
  children,
  testId,
}: {
  kind: "info" | "warn" | "error" | "success";
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className={`np-notice np-notice-${kind}`} role={kind === "error" ? "alert" : "status"} data-testid={testId}>
      {children}
    </div>
  );
}

export function Section({ title, children, testId }: { title?: string; children: ReactNode; testId?: string }) {
  return (
    <section className="np-section" data-testid={testId}>
      {title ? <h2 className="np-h2">{title}</h2> : null}
      {children}
    </section>
  );
}
