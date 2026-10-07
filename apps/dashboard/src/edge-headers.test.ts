/**
 * The one header at the edge that can stop every form in this dashboard working.
 *
 * This is a test about a file the dashboard does not read, which needs saying.
 * `deploy/Caddyfile` is what serves the dashboard's pages on a deployment, and one
 * of the headers it sets decides whether the browser will tell us where a form
 * came from. The dashboard then refuses forms that came from somewhere else. Those
 * two facts live in two repositoriesworth of distance from each other — a header
 * block in a web server's configuration and a middleware in an express app — and
 * nothing connected them until this file.
 *
 * What happened without it: the edge sent `Referrer-Policy: no-referrer`,
 * because it looked like free hardening and the comment beside it said it
 * "cannot break a page". By the fetch specification a request whose method is
 * not GET or HEAD and whose referrer policy is `no-referrer` carries
 * `Origin: null` rather than the page's own origin. Every form post in the
 * dashboard therefore arrived claiming to come from nowhere, the check refused it,
 * and a merchant could not sign into the live site at all. It cost the better
 * part of a day, and the reason it cost that much is that nothing about it
 * looked like a header: the identical request from a command line, which
 * implements no referrer policy, sailed through, so the evidence pointed at the
 * check rather than at the page it was checking.
 *
 * The charter says a rule moves into a machine once it has slipped past people.
 * This one did.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const caddyfile = resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
  "deploy",
  "Caddyfile",
);

/**
 * The referrer policies a browser reads as "send no origin either".
 *
 * One entry, because one value has this effect. It is a list rather than a
 * comparison so that a second value with the same consequence has somewhere to
 * go, and so the name of the list says what the entries have in common.
 */
const POLICIES_THAT_NULL_THE_ORIGIN = ["no-referrer"];

/**
 * Every Referrer-Policy the Caddyfile sets, wherever and however it sets it.
 *
 * Not only the site-wide block: a `header` line with a matcher overrides it
 * for the pages it matches, and the page the sign-in mail links to is one of
 * those — a page whose whole job is a form post. Caddy reads header names
 * without regard to case and lets a value be quoted, so this does too. A line
 * that names the header and yields no value it can read comes back whole, so
 * that it fails the list of policies below instead of being skipped.
 */
const policiesSet = (): string[] =>
  readFileSync(caddyfile, "utf8")
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "").trim())
    .filter((line) => /referrer-policy/i.test(line))
    .map((line) => /referrer-policy\s+"?([^"\s]+)"?$/i.exec(line)?.[1] ?? line);

describe("the headers the edge puts on the dashboard's pages", () => {
  it("does not use a referrer policy that makes a browser hide the origin", () => {
    const said = policiesSet();
    // A search that found nothing to search would pass for the wrong reason.
    expect(said, "the Caddyfile sets no Referrer-Policy this test could read").not.toEqual([]);

    for (const policy of said) {
      expect(
        POLICIES_THAT_NULL_THE_ORIGIN,
        `Referrer-Policy is "${policy}", and a browser then posts every form with Origin: null,` +
          " which the dashboard refuses — nobody can sign in. Use same-origin.",
      ).not.toContain(policy);
    }
  });

  it("still keeps a referrer off other people's sites", () => {
    // The reason the line exists at all. Dropping the header entirely would
    // also fix the sign-in, and it would send the address of a merchant's
    // dashboard page to whatever they click through to.
    const said = policiesSet();
    expect(said).not.toEqual([]);

    for (const policy of said) {
      expect(["same-origin", "strict-origin", "strict-origin-when-cross-origin"]).toContain(policy);
    }
  });
});
