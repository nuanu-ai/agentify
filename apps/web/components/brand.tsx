import Link from "next/link";
import React from "react";

import { DISPLAY_BRAND } from "../lib/brand";
import { BrandMark } from "./brand-mark";

export function Brand({ inverse = false }: Readonly<{ inverse?: boolean }>) {
  return (
    <Link
      className="brand"
      href="/owner"
      style={inverse ? { color: "var(--paper)" } : undefined}
    >
      <BrandMark className="brand-mark" />
      <span>{DISPLAY_BRAND}</span>
    </Link>
  );
}
