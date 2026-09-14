import { ImageResponse } from "next/og";

import { BrandMark } from "../components/brand-mark";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
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
    size,
  );
}
