/**
 * A person reads every moment on a dashboard page in the zone their browser
 * named, with the zone said beside it; a page drawn for a browser that named
 * none says UTC. Mail goes to people the page was not drawn for, so it stays
 * in UTC whoever's press sent it.
 */

import { describe, expect, it } from "vitest";
import { operatorFlagMessage } from "./admin/operator-mail.js";
import { clockOf, dayOf, inViewersZone, moment } from "./moments.js";
import { momentView } from "./views.js";
import { rateNoticeMessage } from "./woo-rate-mail.js";

const AT = "2026-10-26T20:03:12.000Z";

describe("a moment on a page", () => {
  it("is written in the viewer's zone and names it", () => {
    inViewersZone("Asia/Makassar", () => {
      expect(moment(AT)).toBe("2026-10-27 04:03:12 UTC+8");
      expect(momentView(AT)).toEqual({ date: "2026-10-27", time: "04:03:12 UTC+8" });
    });
  });

  it("is written in UTC and says so where the viewer's zone is not known", () => {
    inViewersZone(null, () => {
      expect(moment(AT)).toBe("2026-10-26 20:03:12 UTC");
    });
    expect(momentView(AT)).toEqual({ date: "2026-10-26", time: "20:03:12 UTC" });
  });

  it("stays in the viewer's zone across everything the page awaits", async () => {
    const written = await inViewersZone("America/Sao_Paulo", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return moment(AT);
    });
    expect(written).toBe("2026-10-26 17:03:12 UTC-3");
  });

  it("keeps the second, whatever offset the instant arrived with", () => {
    // Receipts are reconciled against a wallet: two payments seconds apart
    // must not look like one line twice.
    expect(moment("2026-08-27T11:12:04+02:00")).toBe("2026-08-27 09:12:04 UTC");
  });

  it("is shown as it came where it cannot be read, rather than invented", () => {
    inViewersZone("Asia/Makassar", () => {
      expect(momentView("yesterday")).toEqual({ text: "yesterday" });
      expect(dayOf("yesterday")).toBe("yesterday");
    });
  });

  it("is written as an hour and minute in the viewer's zone, naming it, where a column holds only the time", () => {
    expect(inViewersZone("Asia/Kathmandu", () => clockOf(Date.parse(AT)))).toBe("01:48 UTC+5:45");
    expect(clockOf(Date.parse(AT))).toBe("20:03 UTC");
  });

  it("falls under the day it is in the viewer's calendar", () => {
    expect(inViewersZone("Asia/Makassar", () => dayOf(AT))).toBe("27 October 2026");
    expect(dayOf(AT)).toBe("26 October 2026");
  });
});

describe("a moment in mail", () => {
  it("tells an account its operator flag changed in UTC, whoever pressed it from wherever", () => {
    const sent = inViewersZone("Asia/Makassar", () =>
      operatorFlagMessage("operator@example.com", {
        email: "colleague@example.com",
        granted: true,
        at: new Date(AT),
        askedBy: "operator@example.com",
        channel: "Live channel",
        accounts: "https://agentify.ad/dashboard/admin/accounts",
      }),
    );
    expect(sent.body).toContain("2026-10-26 20:03:12 UTC");
    expect(sent.body).not.toContain("UTC+8");
  });

  it("is written in UTC even while a page is drawn for a viewer in another zone", () => {
    const sent = inViewersZone("Asia/Makassar", () =>
      rateNoticeMessage({
        to: "owner@example.com",
        shopOrigin: "https://shop.example.com",
        currency: "IDR",
        rate: "16500",
        previous: null,
        setAt: new Date(AT),
        sessionSignedInAt: new Date("2026-10-26T08:00:00.000Z"),
        screen: "https://dashboard.example.com/woocommerce",
      }),
    );
    expect(sent.body).toContain("2026-10-26 20:03:12 UTC");
    expect(sent.body).toContain("2026-10-26 08:00:00 UTC");
    expect(sent.body).not.toContain("UTC+8");
  });
});
