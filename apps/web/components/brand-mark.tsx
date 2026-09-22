import type { CSSProperties } from "react";

export const AGENTIFY_MARK_LEFT_PATH =
  "M50 40 H40 A6 6 0 0 0 34 46 V82 A6 6 0 0 0 40 88 H50";
export const AGENTIFY_MARK_RIGHT_PATH =
  "M78 40 H88 A6 6 0 0 1 94 46 V82 A6 6 0 0 1 88 88 H78";

export function BrandMark({
  className,
  size,
  style,
  title,
  variant = "standard",
}: Readonly<{
  className?: string;
  size?: number;
  style?: CSSProperties;
  title?: string;
  variant?: "standard" | "tiny";
}>) {
  const tiny = variant === "tiny";
  return (
    <svg
      aria-hidden={title ? undefined : true}
      aria-label={title}
      className={className}
      data-agentify-mark={variant}
      fill="none"
      focusable="false"
      height={size}
      role={title ? "img" : undefined}
      style={style}
      viewBox="0 0 128 128"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect fill="#0F736E" height="128" rx={tiny ? 22 : 30} width="128" />
      <path
        d={AGENTIFY_MARK_LEFT_PATH}
        fill="none"
        stroke="#F6F4EF"
        strokeLinecap="round"
        strokeWidth={tiny ? 9 : 7}
      />
      <path
        d={AGENTIFY_MARK_RIGHT_PATH}
        fill="none"
        stroke="#F6F4EF"
        strokeLinecap="round"
        strokeWidth={tiny ? 9 : 7}
      />
      <circle cx="64" cy="64" fill="#F6F4EF" r={tiny ? 12 : 10} />
    </svg>
  );
}
