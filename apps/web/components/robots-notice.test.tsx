import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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
    expect(markup).toContain('data-robots-notice="disallowed"');
    expect(markup).toContain("3 checks were");
    expect(markup).toContain('data-robots-notice="unassessed"');
    expect(markup).toContain("1 check was");
  });
});
