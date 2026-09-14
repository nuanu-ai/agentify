import Link from "next/link";
import React from "react";

import { getPublicAppConfig } from "../lib/app-config";
import { BrandMark } from "./brand-mark";

export function Brand({ inverse = false }: Readonly<{ inverse?: boolean }>) {
  const { displayBrand } = getPublicAppConfig();
  return (
    <Link
      className="brand"
      href="/owner"
      style={inverse ? { color: "var(--paper)" } : undefined}
    >
      <BrandMark className="brand-mark" />
      <span>{displayBrand}</span>
    </Link>
  );
}
