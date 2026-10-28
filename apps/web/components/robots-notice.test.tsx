import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { documentOf } from "../testing/markup";

import { RobotsNotice } from "./robots-notice";

describe("RobotsNotice", () => {
  it("counts the checks robots.txt kept the scanner from, one notice per reason", () => {
    const markup = renderToStaticMarkup(
      <RobotsNotice
        checks={[
          { id: 1, robots: null },
          { id: 9, robots: "disallowed" },
          { id: 10, robots: "disallowed" },
          { id: 12, robots: "unassessed" },
          { id: 17, robots: "disallowed" },
        ]}
      />,
    );
    const page = documentOf(markup);
    for (const [reason, count] of [
      ["disallowed", 3],
      ["unassessed", 1],
    ] as const) {
      const notices = page.querySelectorAll(`[data-robots-notice="${reason}"]`);
      expect(notices).toHaveLength(1);
      expect(notices[0]?.textContent).toMatch(new RegExp(`\\b${count} checks?\\b`));
    }
  });

  it("leads the owner to how the scanner reads robots.txt, whatever kept a check out", () => {
    for (const robots of ["disallowed", "unassessed"] as const) {
      const markup = renderToStaticMarkup(<RobotsNotice checks={[{ id: 9, robots }]} />);

      expect(markup, robots).toMatch(/<a href="\/docs\/scanner#robots">[^<]+<\/a>/);
    }
  });
});
