/*
 * A ceiling on the words a screen may show.
 *
 * Every other rule in this repository about length is text, and text is what
 * it stayed: the front page reached 332 explanatory words, the scan screen
 * 285 at once, and nobody noticed, because each sentence was added by itself
 * and each one looked reasonable by itself. One panel already had this test
 * (report-action-panel.test.tsx) and that panel is the one place the drift did
 * not happen. So the rule moves into a machine here too.
 *
 * The count is every visible word, not only the explanatory ones — headings,
 * button labels, navigation and the footer included, because a reader does not
 * sort them as they read. The ceilings are set a little above what these
 * screens show today: the test is there to catch a screen growing back, not to
 * argue about a sentence.
 *
 * If one of these fails, the question is not "which number do I raise" but
 * "which of these words is the reader not acting on".
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { LANDINGS } from "../content/landing";
import { LandingPage } from "./landing-page";
import { PendingScanExperience } from "./pending-scan-experience";
import { ScanExperience } from "./scan-experience";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch: () => undefined, push: () => undefined }),
}));

Object.assign(globalThis, { React });

function visibleWords(markup: string): number {
  return markup
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ").length;
}

describe("how much a screen asks a reader to read", () => {
  it("keeps the front page to the result and the next action", () => {
    const markup = renderToStaticMarkup(
      <LandingPage config={LANDINGS.owner} />,
    );

    expect(visibleWords(markup)).toBeLessThan(210);
  });

  it("keeps the waiting screen to what is happening", () => {
    const markup = renderToStaticMarkup(
      <PendingScanExperience turnstileSiteKey={null} />,
    );

    expect(visibleWords(markup)).toBeLessThan(30);
  });

  it("keeps the scan result to the score, the findings and the gate", () => {
    const markup = renderToStaticMarkup(
      <ScanExperience
        browserObservationsEnabled={false}
        fixture="teaser"
        publicShareEnabled
        registrationEnabled
        remediationPromptEnabled
        scanId="018f3f56-2ec8-7b16-8f66-5b8f93f3251f"
        segment="owner"
      />,
    );

    expect(visibleWords(markup)).toBeLessThan(200);
  });
});
