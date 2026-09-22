import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReportCabinetAction } from "./report-cabinet-control";

describe("fresh report cabinet action", () => {
  it("uses one stable native POST without exposing the handoff token", () => {
    const reportPath = "/report/018f5e6f-7a5d-7c0b-8f58-a6b2fe16ca01";
    const markup = renderToStaticMarkup(
      <ReportCabinetAction email="owner@example.com" reportPath={reportPath} />,
    );

    expect(markup).toContain(
      '<form action="/cabinet/report-handoff" method="post">',
    );
    expect(markup).toContain(
      'type="hidden" name="email" value="owner@example.com"',
    );
    expect(markup).toContain(
      `type="hidden" name="report_path" value="${reportPath}"`,
    );
    expect(markup).toContain('type="submit">Open your cabinet</button>');
    expect(markup).not.toContain("token");
    expect(markup).not.toContain("<a");
    expect(markup).not.toContain("script");
  });
});
