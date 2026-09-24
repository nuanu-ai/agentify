import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReportCabinetControl } from "./report-cabinet-control";

describe("the report's way into the cabinet", () => {
  it("is an ordinary link that makes nothing on its own", () => {
    // Under Lax a link from another site arrives signed in, so opening the
    // cabinet from a report must not be able to make a merchant: the cabinet
    // offers the one control that does (ADR-0026 §4). A form here would be a
    // cross-surface POST that a page could forge.
    const markup = renderToStaticMarkup(<ReportCabinetControl />);

    expect(markup).toContain('href="/cabinet/"');
    expect(markup).not.toContain("<form");
    expect(markup).not.toContain("method=");
  });
});
