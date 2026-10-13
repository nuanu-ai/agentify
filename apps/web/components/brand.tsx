import { DISPLAY_BRAND } from "../lib/brand";
import { BrandMark } from "./brand-mark";
import { SiteLink } from "./site-link";

export function Brand({ inverse = false }: Readonly<{ inverse?: boolean }>) {
  return (
    <SiteLink className="brand" style={inverse ? { color: "var(--bg)" } : undefined} to="/">
      <BrandMark className="brand-mark" />
      <span>{DISPLAY_BRAND}</span>
    </SiteLink>
  );
}
