import type { PublicShareSnapshot } from "@agentify/scanner-contracts";

import { BrandMark } from "@agentify/ui";
import { getPublicAppConfig } from "../app-config";
import { type ShareTone, shareCopy } from "../share-copy";
import { drawPng, HUMAN_FONT, MONO_FONT } from "./drawing";

const TONE: Record<ShareTone, { color: string; soft: string }> = {
  critical: { color: "#B4462F", soft: "#F7E9E4" },
  warning: { color: "#926310", soft: "#F3ECD9" },
  neutral: { color: "#0F736E", soft: "#E6F0EF" },
  positive: { color: "#2C774F", soft: "#E7F1EA" },
};

const SHARE_IMAGE_SIZE = { width: 1200, height: 630 } as const;

const ZONES = [
  { key: "invisible", name: "Invisible", range: "0–24" },
  { key: "readable", name: "Readable", range: "25–49" },
  { key: "callable_ready", name: "Callable", range: "50–69" },
  { key: "ahead_of_market", name: "Ahead", range: "70–100" },
];

/** The card a published share unfurls into, and the picture a visitor downloads of it. */
export function drawShareImage(snapshot: PublicShareSnapshot): Promise<Uint8Array<ArrayBuffer>> {
  const { displayBrand } = getPublicAppConfig();
  const copy = shareCopy(snapshot);
  const tone = TONE[copy.tone];
  const score = Math.max(0, Math.min(100, snapshot.score));
  const pct = score / 100;
  const circumference = 2 * Math.PI * 120;
  const dash = circumference * pct;
  const date = new Date(snapshot.generated_at).toISOString().slice(0, 10);

  return drawPng(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        padding: 40,
        background: "#EFEBE2",
        fontFamily: HUMAN_FONT,
      }}
    >
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 60,
          borderRadius: 28,
          border: "1px solid #E7E3DB",
          background: "#FFFFFF",
          backgroundImage: `radial-gradient(680px 360px at 88% 4%, ${tone.soft}, transparent 62%)`,
          color: "#1A1917",
          boxShadow: "0 30px 70px -46px rgba(26,25,23,0.42)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <BrandMark size={40} />
            <strong
              style={{
                fontSize: 30,
                fontWeight: 600,
                letterSpacing: "-0.02em",
              }}
            >
              {displayBrand}
            </strong>
            <span
              style={{
                color: "#726F69",
                fontFamily: MONO_FONT,
                fontSize: 20,
                letterSpacing: 2,
              }}
            >
              · AGENT-READINESS
            </span>
          </div>
          <span
            style={{
              color: "#726F69",
              fontFamily: MONO_FONT,
              fontSize: 20,
            }}
          >
            {date}
          </span>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 40,
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              maxWidth: 600,
              gap: 22,
            }}
          >
            <div style={{ display: "flex" }}>
              <span
                style={{
                  display: "flex",
                  padding: "9px 20px",
                  borderRadius: 999,
                  background: tone.soft,
                  border: `1px solid ${tone.color}`,
                  color: tone.color,
                  fontFamily: MONO_FONT,
                  fontSize: 22,
                  fontWeight: 500,
                  letterSpacing: 2,
                  textTransform: "uppercase",
                }}
              >
                {copy.kicker}
              </span>
            </div>
            <strong style={{ fontSize: 52, fontWeight: 600, lineHeight: 1.12 }}>
              {copy.headline}
            </strong>
            <span style={{ fontSize: 25, color: "#6B6862", lineHeight: 1.4 }}>{copy.subline}</span>
          </div>

          <div
            style={{
              position: "relative",
              width: 280,
              height: 280,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg width="280" height="280" viewBox="0 0 280 280" style={{ position: "absolute" }}>
              <circle cx="140" cy="140" r="120" fill="none" stroke="#E7E3DB" strokeWidth="20" />
              <circle
                cx="140"
                cy="140"
                r="120"
                fill="none"
                stroke={tone.color}
                strokeWidth="20"
                strokeLinecap="round"
                strokeDasharray={`${dash} ${circumference - dash}`}
                transform="rotate(-90 140 140)"
              />
            </svg>
            <div style={{ display: "flex", alignItems: "baseline" }}>
              <strong
                style={{
                  fontSize: 108,
                  fontWeight: 600,
                  lineHeight: 1,
                  color: tone.color,
                }}
              >
                {score}
              </strong>
              <span style={{ fontSize: 30, color: "#726F69" }}>/100</span>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div
            style={{
              display: "flex",
              height: 12,
              borderRadius: 999,
              background: "#EFEBE2",
            }}
          >
            <div
              style={{
                display: "flex",
                width: `${pct * 100}%`,
                borderRadius: 999,
                background: tone.color,
              }}
            />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            {ZONES.map((zone) => {
              const active = zone.key === snapshot.level;
              return (
                <div
                  key={zone.key}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                    color: active ? tone.color : "#726F69",
                    fontFamily: MONO_FONT,
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  <span style={{ fontSize: 18 }}>{zone.name}</span>
                  <span style={{ fontSize: 15, color: "#726F69" }}>{zone.range}</span>
                </div>
              );
            })}
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: 8,
              fontFamily: MONO_FONT,
              fontSize: 19,
            }}
          >
            <span style={{ color: "#726F69" }}>Diagnostic, not a certification</span>
            <span style={{ color: "#0F736E", fontWeight: 500 }}>Scan yours → agentify.ad</span>
          </div>
        </div>
      </div>
    </div>,
    SHARE_IMAGE_SIZE,
  );
}
