import { ImageResponse } from "next/og";

import { BrandMark } from "../components/brand-mark";
import { getPublicAppConfig } from "../lib/app-config";
import {
  BRAND_IMAGE_FONTS,
  BRAND_IMAGE_HUMAN_FONT,
  BRAND_IMAGE_MONO_FONT,
} from "../lib/server/brand-image";

export const alt = "Agentify website agent-readiness diagnostic";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  const { displayBrand } = getPublicAppConfig();
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        padding: 48,
        background: "#EFEBE2",
        color: "#1A1917",
        fontFamily: BRAND_IMAGE_HUMAN_FONT,
      }}
    >
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 64,
          border: "1px solid #E7E3DB",
          borderRadius: 28,
          background: "#F6F4EF",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <BrandMark size={54} />
          <strong style={{ fontSize: 40, fontWeight: 600, letterSpacing: "-0.02em" }}>
            {displayBrand}
          </strong>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            maxWidth: 920,
            gap: 20,
          }}
        >
          <span
            style={{
              color: "#0F736E",
              fontFamily: BRAND_IMAGE_MONO_FONT,
              fontSize: 22,
              fontWeight: 500,
              letterSpacing: 2.8,
              textTransform: "uppercase",
            }}
          >
            Website agent-readiness diagnostic
          </span>
          <strong
            style={{
              fontSize: 68,
              fontWeight: 600,
              letterSpacing: "-0.035em",
              lineHeight: 1.05,
            }}
          >
            See what your website makes readable to AI agents.
          </strong>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            color: "#6B6862",
            fontFamily: BRAND_IMAGE_MONO_FONT,
            fontSize: 18,
          }}
        >
          <span>Public HTTP · evidence first</span>
          <span style={{ color: "#0F736E", fontWeight: 500 }}>agentify.ad</span>
        </div>
      </div>
    </div>,
    {
      ...size,
      fonts: BRAND_IMAGE_FONTS.length ? [...BRAND_IMAGE_FONTS] : undefined,
    },
  );
}
