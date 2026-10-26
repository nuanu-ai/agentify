import { createHash, randomUUID } from "node:crypto";
import type { PublicShareSnapshot } from "@agentify/scanner-contracts";

import { BrandMark } from "@agentify/ui";
import { getPublicAppConfig } from "../app-config";
import { cleanHost, type ShareCopy, type ShareTone, shareCopy } from "../share-copy";
import {
  drawPng,
  HUMAN_FONT,
  laidOutSize,
  MONO_FONT,
  PICTURE_CACHE_CONTROL,
  pictureAnswer,
} from "./drawing";

/**
 * The site's colours the picture draws with, named as the tokens in
 * `packages/visual/tokens.css` they copy, since it is drawn where no
 * stylesheet applies; a test holds each to its token.
 */
export const INK = {
  fg: "#1A1917",
  muted: "#6B6862",
  faint: "#726F69",
  line: "#E7E3DB",
  accent: "#0F736E",
  "accent-soft": "#E6F0EF",
  pass: "#2C774F",
  "pass-soft": "#E7F1EA",
  partial: "#926310",
  fail: "#B4462F",
} as const;

const TONE: Record<ShareTone, { color: string; soft: string }> = {
  critical: { color: INK.fail, soft: "#F7E9E4" },
  warning: { color: INK.partial, soft: "#F3ECD9" },
  neutral: { color: INK.accent, soft: INK["accent-soft"] },
  positive: { color: INK.pass, soft: INK["pass-soft"] },
};

const SHARE_IMAGE_SIZE = { width: 1200, height: 630 } as const;

// Every block of the card but the statement has a fixed size, so the room
// left for the statement is known before anything is drawn.
const GROUND = 36;
const CARD_BORDER = 1;
const CARD_PADDING = { x: 56, y: 44 } as const;
const HEADER_HEIGHT = 40;
const BAND_GAP = 24;
const FOOT_HEIGHT = 114;
const RING_SIZE = 256;
const RING_STROKE = 20;
const RING_GAP = 48;

const STATEMENT_WIDTH =
  SHARE_IMAGE_SIZE.width - 2 * (GROUND + CARD_BORDER + CARD_PADDING.x) - RING_SIZE - RING_GAP;
const STATEMENT_HEIGHT =
  SHARE_IMAGE_SIZE.height -
  2 * (GROUND + CARD_BORDER + CARD_PADDING.y) -
  HEADER_HEIGHT -
  2 * BAND_GAP -
  FOOT_HEIGHT;

/** Headline sizes, largest first; a host the smallest cannot hold is shortened. */
const SMALLEST_HEADLINE = 30;
const HEADLINE_SIZES = [52, 46, 40, 35, SMALLEST_HEADLINE];
const ELLIPSIS = "…";

/** Score sizes, largest first; the smallest holds 100 inside the ring. */
const SCORE_SIZES = [98, 90, 82, 74, 66];
/**
 * How wide the score may be: the clear space inside the stroke, less a margin
 * on each side, since figures as wide as that space would touch the stroke
 * with their corners.
 */
const SCORE_WIDTH = RING_SIZE - 3 * RING_STROKE - 2 * 14;

const ZONES = [
  { key: "invisible", name: "Invisible", range: "0–24" },
  { key: "readable", name: "Readable", range: "25–49" },
  { key: "callable_ready", name: "Callable", range: "50–69" },
  { key: "ahead_of_market", name: "Ahead", range: "70–100" },
];

type Tone = (typeof TONE)[ShareTone];

function Statement({ copy, tone, size }: { copy: ShareCopy; tone: Tone; size: number }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: STATEMENT_WIDTH,
        gap: 20,
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
      {/* A host is one word to the layout, and one label may be wider than
          the column, so a word breaks wherever it has to. */}
      <strong
        style={{ fontSize: size, fontWeight: 600, lineHeight: 1.12, wordBreak: "break-word" }}
      >
        {copy.headline}
      </strong>
      <span style={{ fontSize: 25, color: INK.muted, lineHeight: 1.4 }}>{copy.subline}</span>
    </div>
  );
}

const fits = async (copy: ShareCopy, tone: Tone, size: number): Promise<boolean> =>
  (await laidOutSize(<Statement copy={copy} tone={tone} size={size} />, STATEMENT_WIDTH)).height <=
  STATEMENT_HEIGHT;

/**
 * `host` cut to about `kept` characters with an ellipsis in its middle. The
 * end it keeps starts at a label, because a label shown from its middle would
 * read as another site's name. A label the cut falls in is kept whole when it
 * fits in `kept`, and the start gives way to it; a label too long for that is
 * left out, and only a cut inside the last label stays where it falls. The
 * dot before the end is left out with the middle, so the ellipsis is never
 * read as one more dot.
 */
const shortened = (host: string, kept: number): string => {
  const cut = host.length - Math.floor(kept / 2);
  const labelStart = host.lastIndexOf(".", cut - 1) + 1;
  const nextDot = host.indexOf(".", cut);
  const endStart =
    labelStart > 0 && host.length - labelStart <= kept
      ? labelStart
      : nextDot >= 0
        ? nextDot + 1
        : cut;
  const end = host.slice(endStart);
  const start = host.slice(0, Math.max(0, kept - end.length));
  return `${start}${ELLIPSIS}${end}`;
};

function Score({ score, tone, size }: { score: number; tone: Tone; size: number }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline" }}>
      <strong style={{ fontSize: size, fontWeight: 600, lineHeight: 1, color: tone.color }}>
        {score}
      </strong>
      <span style={{ fontSize: Math.round((size * 2) / 7), color: INK.faint }}>/100</span>
    </div>
  );
}

/** The largest score size whose figures fit inside the ring. */
async function scoreSize(score: number, tone: Tone): Promise<number> {
  for (const size of SCORE_SIZES)
    if (
      (await laidOutSize(<Score score={score} tone={tone} size={size} />, RING_SIZE)).width <=
      SCORE_WIDTH
    )
      return size;
  return SCORE_SIZES[SCORE_SIZES.length - 1] ?? 0;
}

/**
 * The statement at the largest headline size that holds it. A host the
 * smallest size cannot hold loses characters from its middle, so the picture
 * still shows where the name starts and the site's own name at its end.
 */
async function fittedStatement(
  snapshot: PublicShareSnapshot,
  tone: Tone,
): Promise<{ copy: ShareCopy; size: number }> {
  const copy = shareCopy(snapshot);
  for (const size of HEADLINE_SIZES) if (await fits(copy, tone, size)) return { copy, size };

  const size = SMALLEST_HEADLINE;
  const host = cleanHost(snapshot.host);
  const copyKeeping = (kept: number) => shareCopy(snapshot, shortened(host, kept));
  let kept = 0;
  let tooMany = host.length;
  while (tooMany - kept > 1) {
    const middle = Math.floor((kept + tooMany) / 2);
    if (await fits(copyKeeping(middle), tone, size)) kept = middle;
    else tooMany = middle;
  }
  return { copy: copyKeeping(kept), size };
}

/** The card a published share unfurls into, and the picture a visitor downloads of it. */
export async function drawShareImage(
  snapshot: PublicShareSnapshot,
): Promise<Uint8Array<ArrayBuffer>> {
  const { displayBrand } = getPublicAppConfig();
  const tone = TONE[shareCopy(snapshot).tone];
  const { copy, size } = await fittedStatement(snapshot, tone);
  const score = Math.max(0, Math.min(100, snapshot.score));
  const scoreFontSize = await scoreSize(score, tone);
  const pct = score / 100;
  const radius = RING_SIZE / 2 - RING_STROKE;
  const circumference = 2 * Math.PI * radius;
  const dash = circumference * pct;
  const date = new Date(snapshot.generated_at).toISOString().slice(0, 10);

  return drawPng(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        padding: GROUND,
        background: "#EFEBE2",
        fontFamily: HUMAN_FONT,
      }}
    >
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          gap: BAND_GAP,
          padding: `${CARD_PADDING.y}px ${CARD_PADDING.x}px`,
          borderRadius: 28,
          border: `${CARD_BORDER}px solid ${INK.line}`,
          background: "#FFFFFF",
          // The renderer fades to `transparent` through black, so the tint
          // fades to itself at no opacity.
          backgroundImage: `radial-gradient(680px 360px at 88% 4%, ${tone.soft}, ${tone.soft}00 62%)`,
          color: INK.fg,
          boxShadow: "0 30px 70px -46px rgba(26,25,23,0.42)",
        }}
      >
        <div
          style={{
            display: "flex",
            height: HEADER_HEIGHT,
            flexShrink: 0,
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <BrandMark size={HEADER_HEIGHT} />
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
                color: INK.faint,
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
              color: INK.faint,
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
            height: STATEMENT_HEIGHT,
            flexShrink: 0,
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Statement copy={copy} tone={tone} size={size} />

          <div
            style={{
              position: "relative",
              width: RING_SIZE,
              height: RING_SIZE,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg
              aria-hidden="true"
              width={RING_SIZE}
              height={RING_SIZE}
              viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
              style={{ position: "absolute" }}
            >
              <circle
                cx={RING_SIZE / 2}
                cy={RING_SIZE / 2}
                r={radius}
                fill="none"
                stroke={INK.line}
                strokeWidth={RING_STROKE}
              />
              <circle
                cx={RING_SIZE / 2}
                cy={RING_SIZE / 2}
                r={radius}
                fill="none"
                stroke={tone.color}
                strokeWidth={RING_STROKE}
                strokeLinecap="round"
                strokeDasharray={`${dash} ${circumference - dash}`}
                transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
              />
            </svg>
            <Score score={score} tone={tone} size={scoreFontSize} />
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            height: FOOT_HEIGHT,
            flexShrink: 0,
            gap: 14,
          }}
        >
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
                    color: active ? tone.color : INK.faint,
                    fontFamily: MONO_FONT,
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  <span style={{ fontSize: 18, lineHeight: "22px" }}>{zone.name}</span>
                  <span style={{ fontSize: 15, lineHeight: "18px", color: INK.faint }}>
                    {zone.range}
                  </span>
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
              lineHeight: "24px",
            }}
          >
            <span style={{ color: INK.faint }}>Diagnostic, not a certification</span>
            <span style={{ color: INK.accent, fontWeight: 500 }}>Scan yours → agentify.ad</span>
          </div>
        </div>
      </div>
    </div>,
    SHARE_IMAGE_SIZE,
  );
}

type Png = Uint8Array<ArrayBuffer>;

/**
 * This process's own mark in every tag, so a picture drawn by an earlier
 * build, which may look different, is never taken for the current one.
 */
const DRAWN_HERE = randomUUID();

/** How many pictures the process keeps, about 160 KB each. */
const KEPT_PICTURES = 32;

/** The pictures drawn last, oldest first; a picture asked for again moves to the end. */
const kept = new Map<string, Promise<Png>>();

const tagOf = (snapshot: PublicShareSnapshot): string =>
  `"${createHash("sha256").update(DRAWN_HERE).update(JSON.stringify(snapshot)).digest("base64url").slice(0, 32)}"`;

const keptPicture = (tag: string, snapshot: PublicShareSnapshot): Promise<Png> => {
  const known = kept.get(tag);
  kept.delete(tag);
  const picture =
    known ??
    drawShareImage(snapshot).catch((error: unknown) => {
      kept.delete(tag);
      throw error;
    });
  kept.set(tag, picture);
  for (const oldest of kept.keys()) {
    if (kept.size <= KEPT_PICTURES) break;
    kept.delete(oldest);
  }
  return picture;
};

const holds = (ifNoneMatch: string | null, tag: string): boolean =>
  (ifNoneMatch ?? "")
    .split(",")
    .map((held) => held.trim().replace(/^W\//, ""))
    .some((held) => held === tag || held === "*");

/**
 * A published share's picture as the answer to `request`, as a file to save
 * named after the site. A share's snapshot never changes, so the picture is
 * tagged by it: a cache holding the tag is answered 304 with nothing to
 * draw, and a picture drawn recently is answered from memory.
 */
export async function sharePictureAnswer(
  request: Request,
  snapshot: PublicShareSnapshot,
): Promise<Response> {
  const tag = tagOf(snapshot);
  if (holds(request.headers.get("if-none-match"), tag))
    return new Response(null, {
      status: 304,
      headers: { ETag: tag, "Cache-Control": PICTURE_CACHE_CONTROL },
    });
  const name = snapshot.host.replace(/[^a-z0-9.-]/gi, "-");
  return pictureAnswer(await keptPicture(tag, snapshot), {
    ETag: tag,
    "Content-Disposition": `attachment; filename="agentify-${name}.png"`,
  });
}
