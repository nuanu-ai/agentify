import { describe, expect, it } from "vitest";

import { robotsNotices, robotsReasonFor } from "./robots-notice";

describe("robots notice", () => {
  it("reads the scanner's robots error codes as the reason a check was not assessed", () => {
    expect(robotsReasonFor("robots_disallowed")).toBe("disallowed");
    expect(robotsReasonFor("robots_unavailable")).toBe("unassessed");
    expect(robotsReasonFor("fetch_timeout")).toBeNull();
    expect(robotsReasonFor(null)).toBeNull();
  });

  it("groups the checks robots.txt kept from being assessed by their reason", () => {
    expect(
      robotsNotices([
        { id: 4, robots: "disallowed" },
        { id: 9, robots: "unassessed" },
        { id: 12, robots: "disallowed" },
        { id: 1, robots: null },
      ]),
    ).toEqual([
      { reason: "disallowed", checkIds: [4, 12] },
      { reason: "unassessed", checkIds: [9] },
    ]);
    expect(robotsNotices([{ id: 1, robots: null }])).toEqual([]);
  });
});
