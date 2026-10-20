/**
 * The scan page drawn from the example states its loader hands it outside
 * production, whole, with the parts it loads once a scan has a result, as a
 * browser would show them before any script of theirs asks the API.
 */

import { prerender } from "react-dom/static";
import { describe, expect, it } from "vitest";
import { scanFixture } from "../lib/scan-fixtures";
import { onSite } from "../testing/on-site";
import { ScanExperience } from "./scan-experience";

const scanId = "018f3f56-2ec8-7b16-8f66-5b8f93f3251f";

/** The example of this name, its status last changed at the moment given. */
const fixtureAt = (name: string, updatedAt: string) => {
  const fixture = scanFixture(name);
  if (fixture === null) throw new Error(`no example named ${name}`);
  return { ...fixture, status: { ...fixture.status, updated_at: updatedAt } };
};

async function drawn(
  fixture: string | ReturnType<typeof fixtureAt>,
  switches: Partial<{ registrationEnabled: boolean; publicShareEnabled: boolean }> = {},
): Promise<string> {
  const { prelude } = await prerender(
    onSite(
      <ScanExperience
        browserObservationsEnabled={false}
        fixture={typeof fixture === "string" ? scanFixture(fixture) : fixture}
        publicShareEnabled
        registrationEnabled
        remediationPromptEnabled
        scanId={scanId}
        segment="owner"
        {...switches}
      />,
    ),
  );
  return new Response(prelude).text();
}

describe("ScanExperience teaser actions", () => {
  it("offers a readable teaser prompt download and scan-token share preview", async () => {
    const markup = await drawn("teaser");

    expect(markup).toContain("Copy AI fix prompt");
    expect(markup).toContain("Download .md");
    expect(markup).toContain("Copy share link");
  });

  it("says before either share button is pressed that both publish a link that can be revoked", async () => {
    // "Download image" also makes the scan's result readable by anyone at a
    // public link; a person who wanted only a file must know before pressing.
    const markup = await drawn("teaser");

    expect(markup).toMatch(/<button[^>]*>[^<]*publish[^<]*image[^<]*<\/button>/i);
    expect(markup).toMatch(/revoke/i);
  });

  it("hides unusable teaser export actions when registration is disabled", async () => {
    const markup = await drawn("teaser", { registrationEnabled: false });

    expect(markup).not.toContain("Copy AI fix prompt");
    expect(markup).not.toContain("Download .md");
    expect(markup).toContain("Copy share link");
  });

  it("tells the owner which checks their robots.txt kept the scanner from", async () => {
    // Robots.txt that disallows the whole site leaves too little to score.
    const failed = await drawn("robots");
    expect(failed).toContain('data-robots-notice="disallowed"');
    expect(failed).toContain('data-robots-headline="disallowed"');
    expect(failed).not.toContain("data-unavailable-notice");
    // Robots.txt that disallows /.well-known/ leaves a scored teaser, in which
    // a check unavailable for another reason is still said to be unavailable.
    const teaser = await drawn("robots-partial");
    expect(teaser).toContain('data-robots-notice="disallowed"');
    expect(teaser).toContain("data-unavailable-notice");
    const partial = await drawn("partial");
    expect(partial).not.toContain("data-robots-notice");
    expect(partial).toContain("data-unavailable-notice");
  });

  it("headlines the scanned host and keeps the wait expectation visible", async () => {
    const markup = await drawn("running");

    expect(markup).toContain("example.com");
    expect(markup).toContain("usually under 60 s");
    expect(markup).not.toContain("Scan 018f3f56");
  });

  it("names the day a finished scan was made, in UTC as its public link names it, and no day while it runs", async () => {
    // Late on the 13th in UTC is already the 14th east of it.
    const finished = await drawn(fixtureAt("teaser", "2026-10-13T23:30:00.000Z"));
    const running = await drawn(fixtureAt("running", "2026-10-13T23:30:00.000Z"));

    expect(finished).toContain("Oct 13, 2026");
    expect(running).not.toContain("2026");
  });

  it("says a scan that ended without a result has none, not that it failed a check", async () => {
    const markup = await drawn("failed");

    expect(markup).toContain("No result");
    expect(markup).not.toMatch(/>Fail</);
  });

  it("keeps privacy choices reachable from the scan help links", async () => {
    expect(await drawn("teaser")).toContain("Privacy choices");
  });
});
