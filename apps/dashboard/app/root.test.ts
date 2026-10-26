/**
 * The document every page is drawn in, run as React Router runs its first
 * middleware: whatever a page writes while it is drawn, its moments are in
 * the zone the reader's browser named.
 */

import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { moment } from "../src/moments.js";
import { middleware } from "./root.js";

const AT = "2026-10-26T20:03:12.000Z";

const drawnFor = async (cookie: string | null): Promise<string> => {
  const zoned = middleware[0];
  if (zoned === undefined) throw new Error("the root route has no middleware");
  const request = new Request("http://127.0.0.1/dashboard/orders", {
    headers: cookie === null ? {} : { cookie },
  });
  const response = await zoned(
    {
      request,
      context: new RouterContextProvider(),
      params: {},
      url: new URL(request.url),
      pattern: "/orders",
    },
    async () => {
      await Promise.resolve();
      return new Response(moment(AT));
    },
  );
  return await (response as Response).text();
};

describe("a page drawn for a browser", () => {
  it("writes its moments in the zone the browser named, and names it", async () => {
    expect(await drawnFor("session=abc; agentify_zone=Asia%2FMakassar")).toBe(
      "2026-10-27 04:03:12 UTC+8",
    );
  });

  it("writes them in UTC, said as UTC, where the browser named none or one nobody knows", async () => {
    expect(await drawnFor(null)).toBe("2026-10-26 20:03:12 UTC");
    expect(await drawnFor("agentify_zone=Nowhere%2FAt_All")).toBe("2026-10-26 20:03:12 UTC");
  });
});
