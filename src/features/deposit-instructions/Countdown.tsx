import { useEffect, useState } from "react";
import { countdown } from "./qr";

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function Countdown({ until, render }: { until: number; render: (label: string) => string }) {
  const now = useNow();
  const { label, ms } = countdown(until, now);
  return (
    <span className={ms < 60_000 ? "np-countdown np-countdown-low" : "np-countdown"} data-testid="countdown">
      {render(label)}
    </span>
  );
}
