import { parseJsonLd } from "@agentify/scanner";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { publicSiteSchema } from "../lib/schema";
import { StructuredData } from "./structured-data";

const originalBaseUrl = process.env.NEXT_PUBLIC_APP_BASE_URL;

afterEach(() => {
  if (originalBaseUrl === undefined)
    delete process.env.NEXT_PUBLIC_APP_BASE_URL;
  else process.env.NEXT_PUBLIC_APP_BASE_URL = originalBaseUrl;
});

describe("StructuredData", () => {
  it("emits an owner-quality Organization and WebSite graph", () => {
    process.env.NEXT_PUBLIC_APP_BASE_URL = "https://agentify.ad";
    const html = renderToStaticMarkup(
      <StructuredData schema={publicSiteSchema()} />,
    );
    const parsed = parseJsonLd(html);
    const organization = parsed.nodes.find(
      (node) => node["@type"] === "Organization",
    );

    expect(parsed).toMatchObject({ scriptCount: 1, invalidCount: 0 });
    expect(organization).toMatchObject({
      name: "Agentify",
      url: "https://agentify.ad/",
      logo: "https://agentify.ad/icon.svg",
      contactPoint: {
        "@type": "ContactPoint",
        email: "abuse@agentify.ad",
      },
    });
    expect(parsed.nodes.some((node) => node["@type"] === "WebSite")).toBe(true);
  });

  it("cannot be escaped by a closing script payload", () => {
    const html = renderToStaticMarkup(
      <StructuredData
        schema={{
          "@context": "https://schema.org",
          value: "</script><script>",
        }}
      />,
    );

    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).not.toContain("</script><script>");
    expect(html).toContain("\\u003c/script>\\u003cscript>");
    expect(parseJsonLd(html)).toMatchObject({
      scriptCount: 1,
      invalidCount: 0,
    });
  });
});
