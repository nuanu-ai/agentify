import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AGENTIFY_MARK_LEFT_PATH,
  AGENTIFY_MARK_RIGHT_PATH,
  BrandMark,
} from "./brand-mark";

describe("BrandMark", () => {
  it("renders the canonical read-frame geometry", () => {
    const markup = renderToStaticMarkup(<BrandMark size={30} />);

    expect(markup).toContain('data-agentify-mark="standard"');
    expect(markup).toContain(`d="${AGENTIFY_MARK_LEFT_PATH}"`);
    expect(markup).toContain(`d="${AGENTIFY_MARK_RIGHT_PATH}"`);
    expect(markup).toContain('stroke-width="7"');
    expect(markup).toContain('r="10"');
    expect(markup).not.toContain("linearGradient");
    expect(markup).not.toContain("filter=");
  });

  it("uses the approved heavy geometry below 24px", () => {
    const markup = renderToStaticMarkup(<BrandMark size={16} variant="tiny" />);

    expect(markup).toContain('data-agentify-mark="tiny"');
    expect(markup).toContain('rx="22"');
    expect(markup).toContain('stroke-width="9"');
    expect(markup).toContain('r="12"');
  });

  it("keeps the metadata favicon synchronized with the heavy mark", () => {
    const icon = readFileSync(resolve(process.cwd(), "app/icon.svg"), "utf8");

    expect(icon).toContain(AGENTIFY_MARK_LEFT_PATH);
    expect(icon).toContain(AGENTIFY_MARK_RIGHT_PATH);
    expect(icon).toContain('stroke-width="9"');
    expect(icon).toContain('r="12"');
  });
});
