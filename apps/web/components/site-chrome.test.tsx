import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SiteFooter } from "./site-chrome";

describe("SiteFooter", () => {
  it("keeps privacy choices reachable from the footer control group", () => {
    const markup = renderToStaticMarkup(<SiteFooter />);
    expect(markup).toContain("Privacy choices");
    expect(markup).toContain("Data request");
  });
});
