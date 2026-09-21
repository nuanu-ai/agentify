import { ImageResponse } from "next/og";
import { BrandMark } from "../../components/brand-mark";
import {
  BRAND_IMAGE_FONTS,
  BRAND_IMAGE_HUMAN_FONT,
  BRAND_IMAGE_MONO_FONT,
} from "../../lib/server/brand-image";

/** The tag beside the brand inside the image; exported so a test can read the image's own words. */
export const tag = "SELL TO AGENTS";
export const alt =
  "Agentify — Sell to agents: your next customer sends an agent";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function AgenticShopImage() {
  return new ImageResponse(
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        padding: 64,
        background: "#F6F4EF",
        color: "#1A1917",
        fontFamily: BRAND_IMAGE_HUMAN_FONT,
        justifyContent: "space-between",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <BrandMark size={52} />
        <span
          style={{ fontSize: 34, fontWeight: 600, letterSpacing: "-0.02em" }}
        >
          Agentify
        </span>
        <span
          style={{
            marginLeft: 20,
            color: "#0F736E",
            fontSize: 22,
            fontFamily: BRAND_IMAGE_MONO_FONT,
          }}
        >
          {tag}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          fontSize: 92,
          fontWeight: 600,
          letterSpacing: "-0.06em",
          lineHeight: 1.04,
        }}
      >
        <span>Your next customer</span>
        <span style={{ color: "#0F736E" }}>sends an agent.</span>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderTop: "1px solid #D9DDD4",
          paddingTop: 26,
          fontSize: 24,
        }}
      >
        <span>Your business. A new way to buy.</span>
        <span style={{ color: "#0F736E" }}>agentify.ad/agentic-shop ↗</span>
      </div>
    </div>,
    {
      ...size,
      fonts: BRAND_IMAGE_FONTS.length ? [...BRAND_IMAGE_FONTS] : undefined,
    },
  );
}
