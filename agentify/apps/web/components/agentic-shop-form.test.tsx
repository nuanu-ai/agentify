import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgenticShopForm } from "./agentic-shop-form";

describe("merchant application before hydration", () => {
  it("disables submission until the client handler is ready", () => {
    const html = renderToStaticMarkup(<AgenticShopForm />);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    expect(html).toContain(
      "Please enable JavaScript to send your application.",
    );
  });

  it("never defaults to putting contact details in a GET query", () => {
    const html = renderToStaticMarkup(<AgenticShopForm />);
    expect(html).toMatch(/<form[^>]*method="post"/);
  });
});
