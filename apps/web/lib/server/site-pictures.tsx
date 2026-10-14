/**
 * The pictures that stand for the site rather than for a scan: the card a link
 * to any page unfurls into, the one for the page about selling to agents, and
 * the icon a phone keeps on its home screen. None of them changes while the
 * process runs, so each is drawn once, when first asked for.
 */

import { BrandMark, SITE_PICTURE } from "@agentify/ui";
import { SELL_TO_AGENTS_PICTURE } from "../../content/pictures";
import { DISPLAY_BRAND } from "../brand";
import { drawPng, HUMAN_FONT, MONO_FONT } from "./drawing";

type Png = Uint8Array<ArrayBuffer>;

const once = (draw: () => Promise<Png>): (() => Promise<Png>) => {
  let drawn: Promise<Png> | undefined;
  return () => {
    drawn ??= draw().catch((error: unknown) => {
      drawn = undefined;
      throw error;
    });
    return drawn;
  };
};

const APPLE_ICON_SIZE = { width: 180, height: 180 } as const;

export const sitePicture = once(() =>
  drawPng(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        padding: 48,
        background: "#EFEBE2",
        color: "#1A1917",
        fontFamily: HUMAN_FONT,
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
            {DISPLAY_BRAND}
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
              fontFamily: MONO_FONT,
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
            fontFamily: MONO_FONT,
            fontSize: 18,
          }}
        >
          <span>Public HTTP · evidence first</span>
          <span style={{ color: "#0F736E", fontWeight: 500 }}>agentify.ad</span>
        </div>
      </div>
    </div>,
    { width: SITE_PICTURE.width, height: SITE_PICTURE.height },
  ),
);

export const sellToAgentsPicture = once(() =>
  drawPng(
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        padding: 64,
        background: "#F6F4EF",
        color: "#1A1917",
        fontFamily: HUMAN_FONT,
        justifyContent: "space-between",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <BrandMark size={52} />
        <span style={{ fontSize: 34, fontWeight: 600, letterSpacing: "-0.02em" }}>Agentify</span>
        <span
          style={{
            marginLeft: 20,
            color: "#0F736E",
            fontSize: 22,
            fontFamily: MONO_FONT,
          }}
        >
          {SELL_TO_AGENTS_PICTURE.tag}
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
    { width: SELL_TO_AGENTS_PICTURE.width, height: SELL_TO_AGENTS_PICTURE.height },
  ),
);

export const appleIcon = once(() =>
  drawPng(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        background: "#0F736E",
      }}
    >
      <BrandMark size={180} />
    </div>,
    APPLE_ICON_SIZE,
  ),
);
