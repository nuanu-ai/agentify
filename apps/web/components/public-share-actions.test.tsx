import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  parseSharePreviewResponse,
  PublicShareActions,
  shareRequestHeaders,
  validatePublishedShare,
} from "./public-share-actions";

const slug = "abcdefghijklmnopqrstuvwxyz_1234567890";

describe("PublicShareActions", () => {
  it("stays absent when sharing is disabled or no public score exists", () => {
    const disabled = renderToStaticMarkup(
      <PublicShareActions
        enabled={false}
        preview={{ hostLabel: "example.com", level: "readable", score: 46 }}
        scanId="scan"
      />,
    );
    const unscored = renderToStaticMarkup(
      <PublicShareActions
        enabled
        preview={{ hostLabel: "example.com", level: "incomplete", score: null }}
        scanId="scan"
      />,
    );

    expect(disabled).toBe("");
    expect(unscored).toBe("");
  });
});

describe("public share response safety", () => {
  it("accepts only a complete versioned public snapshot preview", () => {
    expect(
      parseSharePreviewResponse(
        {
          host: "example.com",
          score: 46,
          level: "readable",
          rubric_version: "gtm-v1.0.0",
          generated_at: "2026-07-13T12:00:00.000Z",
          existing_share: null,
        },
        "https://agentify.ad",
      ),
    ).toEqual({
      preview: { hostLabel: "example.com", score: 46, level: "readable" },
      existingShare: null,
    });
    expect(
      parseSharePreviewResponse(
        { host: "placeholder", score: 46, level: "readable" },
        "https://agentify.ad",
      ),
    ).toBeNull();
  });

  it("restores a live published share only for a same-origin canonical URL", () => {
    const payload = {
      host: "example.com",
      score: 46,
      level: "readable",
      rubric_version: "gtm-v1.0.0",
      generated_at: "2026-07-13T12:00:00.000Z",
      existing_share: {
        slug,
        public_url: `https://agentify.ad/s/${slug}`,
        status: "published",
      },
    };
    expect(parseSharePreviewResponse(payload, "https://agentify.ad")).toEqual({
      preview: { hostLabel: "example.com", score: 46, level: "readable" },
      existingShare: { slug, url: `https://agentify.ad/s/${slug}` },
    });
    expect(
      parseSharePreviewResponse(
        {
          ...payload,
          existing_share: {
            ...payload.existing_share,
            public_url: `https://attacker.test/s/${slug}`,
          },
        },
        "https://agentify.ad",
      ),
    ).toEqual({
      preview: { hostLabel: "example.com", score: 46, level: "readable" },
      existingShare: null,
    });
  });

  it("accepts only a same-origin canonical share URL", () => {
    expect(
      validatePublishedShare(
        { slug, public_url: `https://agentify.ad/s/${slug}` },
        "https://agentify.ad",
      ),
    ).toEqual({ slug, url: `https://agentify.ad/s/${slug}` });
    expect(
      validatePublishedShare(
        { slug, public_url: `https://attacker.test/s/${slug}` },
        "https://agentify.ad",
      ),
    ).toBeNull();
    expect(
      validatePublishedShare(
        { slug, public_url: `https://agentify.ad/s/${slug}?token=leak` },
        "https://agentify.ad",
      ),
    ).toBeNull();
  });

  it("adds the scan capability only when supplied", () => {
    expect(shareRequestHeaders("scan-token", true)).toEqual({
      Authorization: "Bearer scan-token",
      "Content-Type": "application/json",
    });
    expect(shareRequestHeaders(null, false)).toEqual({});
  });
});
