import { describe, expect, it } from "vitest";

import {
  LANDING_SEGMENT_ATTRIBUTE,
  LANDING_VARIANT_ATTRIBUTE,
  readLandingAnnouncement,
} from "./landing-announcement";

/** A root that answers an attribute selector the way the DOM does: `[name]` finds the element only if it carries that attribute. */
const rootWith = (attributes: Record<string, string> | null) => ({
  querySelector: (selector: string) => {
    const wanted = /^\[([^\]=]+)\]$/.exec(selector)?.[1];
    if (!wanted || attributes === null || !(wanted in attributes)) return null;
    return { getAttribute: (name: string) => attributes[name] ?? null };
  },
});

describe("what a landing page announces about itself", () => {
  it("is the segment and the variant the page rendered, not anything derived from the path", () => {
    const announcement = readLandingAnnouncement(
      rootWith({
        [LANDING_SEGMENT_ATTRIBUTE]: "store",
        [LANDING_VARIANT_ATTRIBUTE]: "store-v1",
      }),
    );

    expect(announcement).toEqual({ segment: "store", variant: "store-v1" });
  });

  it("is nothing on a page that is not a landing", () => {
    expect(readLandingAnnouncement(rootWith(null))).toBeNull();
  });

  it("is nothing when the announced segment is not one the product knows, so no event is recorded for it", () => {
    expect(
      readLandingAnnouncement(
        rootWith({
          [LANDING_SEGMENT_ATTRIBUTE]: "wholesale",
          [LANDING_VARIANT_ATTRIBUTE]: "wholesale-v1",
        }),
      ),
    ).toBeNull();
    expect(
      readLandingAnnouncement(
        rootWith({ [LANDING_SEGMENT_ATTRIBUTE]: "owner" }),
      ),
    ).toBeNull();
  });
});
