import { describe, expect, it } from "vitest";

import { robotsHeadline, robotsNotices, robotsReasonFor } from "./robots-notice";

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

  it("blames robots.txt in a headline only for a scan it alone kept out", () => {
    type Check = {
      id: number;
      status: "pass" | "fail" | "unavailable";
      robots: "disallowed" | "unassessed" | null;
    };
    const scan = (read: (id: number) => Omit<Check, "id">): Check[] =>
      Array.from({ length: 18 }, (_, index) => ({ id: index + 1, ...read(index + 1) }));
    const pass = { status: "pass", robots: null } as const;
    // robots.txt disallows the whole site: the three checks of robots.txt pass.
    expect(
      robotsHeadline(
        scan((id) => (id <= 3 ? pass : { status: "unavailable", robots: "disallowed" })),
      ),
    ).toBe("disallowed");
    // A WAF answers 403 to everything, robots.txt included.
    expect(
      robotsHeadline(
        scan((id) =>
          id <= 3
            ? { status: "fail", robots: null }
            : { status: "unavailable", robots: "unassessed" },
        ),
      ),
    ).toBe("unassessed");
    // The site times out: robots.txt itself was never read.
    expect(
      robotsHeadline(
        scan((id) =>
          id <= 3
            ? { status: "unavailable", robots: null }
            : { status: "unavailable", robots: "unassessed" },
        ),
      ),
    ).toBeNull();
    // robots.txt disallows /.well-known/ while everything else times out.
    expect(
      robotsHeadline(
        scan((id) =>
          [9, 10, 17].includes(id)
            ? { status: "unavailable", robots: "disallowed" }
            : { status: "unavailable", robots: null },
        ),
      ),
    ).toBeNull();
  });
});
