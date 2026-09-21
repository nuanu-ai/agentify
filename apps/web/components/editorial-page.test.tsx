import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EditorialPage } from "./editorial-page";

describe("EditorialPage", () => {
  it("carries the doors to the documentation and the cabinet", () => {
    const markup = renderToStaticMarkup(
      <EditorialPage
        eyebrow="Trust"
        intro="What the scanner reads."
        sections={[
          { id: "scope", title: "Scope", content: <p>Public HTTP.</p> },
        ]}
        title="Methodology"
      />,
    );

    expect(markup).toContain('href="/docs/"');
    expect(markup).toContain('href="/cabinet/sign-in"');
  });
});
