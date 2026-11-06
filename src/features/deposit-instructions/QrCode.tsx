import { useMemo } from "react";
import { encode } from "uqr";

/** QR code rendered as one SVG path (no inline styles: CSP style-src 'self'). */
export function QrCode({ value, label }: { value: string; label: string }) {
  const { d, size } = useMemo(() => {
    const qr = encode(value, { ecc: "M", border: 2 });
    let path = "";
    qr.data.forEach((row, y) => {
      row.forEach((on, x) => {
        if (on) path += `M${x} ${y}h1v1h-1z`;
      });
    });
    return { d: path, size: qr.size };
  }, [value]);
  return (
    <svg
      className="np-qr"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      data-testid="qr"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
