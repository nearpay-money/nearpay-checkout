/**
 * Chain and token logos (bundled SVGs from `@web3icons/core`, src/assets/crypto/): self-hosted hashed
 * assets (CSP `img-src 'self'`), no JavaScript per icon. Chains are rounded squares, tokens circles, so a
 * network never reads as a token. Unknown chains/tokens — or a logo that fails to load — fall back to the
 * kit's letter avatar. Always decorative (`alt=""`): the name is printed next to it.
 */
import { Avatar, cx } from "@nearpay-internal/ui";
import { useState } from "react";
import { chainIconName, tokenIconName } from "../lib/chains/icons";

const URLS = import.meta.glob<string>("../assets/crypto/*.svg", { eager: true, query: "?url", import: "default" });

/** Hashed URL of a bundled icon file, or null. */
export function iconUrl(name: string | null): string | null {
  return name ? (URLS[`../assets/crypto/${name}.svg`] ?? null) : null;
}

export interface CryptoIconProps {
  kind: "chain" | "token";
  /** CAIP-2 chain id (or the NEAR Intents network key) for chains, the symbol for tokens. */
  id: string;
  /** Letter avatar text when there is no logo (defaults to `id`). */
  label?: string;
  size?: "xs" | "sm" | "md";
  className?: string;
}

export function CryptoIcon({ kind, id, label, size = "sm", className }: CryptoIconProps) {
  const src = iconUrl(kind === "chain" ? chainIconName(id) : tokenIconName(id));
  const [failed, setFailed] = useState<string | null>(null);
  const classes = cx("ck-coin", `ck-coin--${kind}`, `ck-coin--${size}`, className);
  if (!src || failed === src) {
    return (
      <Avatar
        initial={label || id || "?"}
        size="sm"
        shape={kind === "chain" ? "square" : "round"}
        className={cx(classes, "ck-coin--letter")}
      />
    );
  }
  return (
    <img
      className={classes}
      src={src}
      alt=""
      aria-hidden="true"
      width={32}
      height={32}
      decoding="async"
      draggable={false}
      onError={() => setFailed(src)}
    />
  );
}
