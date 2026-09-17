import { describe, expect, it } from "vitest";

import nextConfig from "./next.config";

describe("private route headers", () => {
  it("prevents auth callback caching, indexing, and referrer leakage", async () => {
    const configuredHeaders = await nextConfig.headers?.();
    const authCallback = configuredHeaders?.find(
      (entry) => entry.source === "/auth/callback",
    );

    expect(authCallback?.headers).toEqual([
      { key: "Cache-Control", value: "private, no-store" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Robots-Tag", value: "noindex, nofollow" },
    ]);
  });

  it("keeps report form origin while limiting its referrer to the origin", async () => {
    const configuredHeaders = await nextConfig.headers?.();
    const report = configuredHeaders?.find(
      (entry) => entry.source === "/report/:path*",
    );

    expect(report?.headers).toEqual([
      { key: "Cache-Control", value: "private, no-store" },
      { key: "Referrer-Policy", value: "strict-origin" },
      { key: "X-Robots-Tag", value: "noindex, nofollow" },
    ]);
  });
});
