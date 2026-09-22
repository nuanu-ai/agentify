import Link from "next/link";

import { DISPLAY_BRAND } from "../lib/brand";
import { BrandMark } from "./brand-mark";

export function Brand({ inverse = false }: Readonly<{ inverse?: boolean }>) {
  return (
    <Link
      className="brand"
      href="/"
      style={inverse ? { color: "var(--bg)" } : undefined}
    >
      <BrandMark className="brand-mark" />
      <span>{DISPLAY_BRAND}</span>
    </Link>
  );
}
