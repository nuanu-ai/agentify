import { BrandMark } from "@agentify/ui";
import { DISPLAY_BRAND } from "../lib/brand";
import { SiteLink } from "./site-link";

export function Brand() {
  return (
    <SiteLink className="brand" to="/">
      <BrandMark className="brand-mark" />
      <span>{DISPLAY_BRAND}</span>
    </SiteLink>
  );
}
