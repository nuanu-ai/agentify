import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReportCabinetAction } from "./report-cabinet-control";

describe("fresh report cabinet action", () => {
  it("requires one explicit native POST with the handoff token in the body", () => {
    const markup = renderToStaticMarkup(
      <ReportCabinetAction
        handoff={{
          action: "/cabinet/sign-in/open",
          token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        }}
      />,
    );

    expect(markup).toContain(
      '<form action="/cabinet/sign-in/open" method="post">',
    );
    expect(markup).toContain('type="hidden" name="token"');
    expect(markup).toContain('value="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"');
    expect(markup).toContain('type="submit">Open your cabinet</button>');
    expect(markup).not.toContain("?token=");
    expect(markup).not.toContain("<a");
    expect(markup).not.toContain("script");
  });

  it("preserves the mailed-link fallback for an old report session", () => {
    const markup = renderToStaticMarkup(
      <ReportCabinetAction email="owner@example.com" handoff={null} />,
    );

    expect(markup).toContain('<form action="/cabinet/sign-in" method="post">');
    expect(markup).toContain('type="hidden" name="email"');
    expect(markup).toContain('value="owner@example.com"');
    expect(markup).toContain("Email me a cabinet link");
    expect(markup).not.toContain('name="token"');
  });
});
