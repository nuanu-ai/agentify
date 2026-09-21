import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import MethodologyPage from "../app/(trust)/methodology/page";

describe("a trust page", () => {
  it("carries the doors to the documentation and the cabinet", () => {
    Object.assign(globalThis, { React });
    const markup = renderToStaticMarkup(<MethodologyPage />);

    expect(markup).toContain('href="/docs/"');
    expect(markup).toContain('href="/cabinet/sign-in"');
  });
});
