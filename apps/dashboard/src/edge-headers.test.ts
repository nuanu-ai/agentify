/**
 * `deploy/Caddyfile` sets the headers the dashboard's pages are served with,
 * and the dashboard refuses a form whose `Origin` is not its own. Under
 * `Referrer-Policy: no-referrer` a browser sends `Origin: null` on every POST,
 * so every form, sign-in included, would be refused, while the same request
 * from a command line goes through. It also writes the header the dashboard
 * counts a client by. Only the Caddyfile's text is read here; no Caddy runs.
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

const POLICIES_THAT_NULL_THE_ORIGIN = ["no-referrer"];

/**
 * Not only the site-wide block: a `header` line with a matcher overrides it for
 * the pages it matches, the sign-in page among them. Header names are read
 * without regard to case and values may be quoted, as Caddy reads them. A line
 * naming the header with no readable value comes back whole, so it fails the
 * check instead of being skipped.
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
    // Dropping the header would also fix sign-in, but would send the address of
    // a merchant's dashboard page to whatever they click through to.
    const said = policiesSet();
    expect(said).not.toEqual([]);

    for (const policy of said) {
      expect(["same-origin", "strict-origin", "strict-origin-when-cross-origin"]).toContain(policy);
    }
  });
});

/**
 * The text of the block a line opens, up to the brace that closes it, with
 * comments left out; null where no line opens it.
 */
const blockOpenedBy = (opening: RegExp): string | null => {
  const lines = readFileSync(caddyfile, "utf8")
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "").trim());
  const first = lines.findIndex((line) => opening.test(line) && line.endsWith("{"));
  if (first === -1) return null;
  let depth = 0;
  const kept: string[] = [];
  for (const line of lines.slice(first)) {
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    kept.push(line);
    if (depth === 0) break;
  }
  return kept.join("\n");
};

describe("what the edge tells the dashboard about who is asking", () => {
  it("replaces whatever X-Forwarded-For a browser sent with the address its trusted-proxy boundary decided", () => {
    // The dashboard counts sign-in links per client by this header. Caddy's
    // default keeps what a trusted peer sent and appends, so without the
    // replacement a browser could pick which client it is counted as.
    const dashboard = blockOpenedBy(/^handle @dashboard\b/);
    expect(
      dashboard,
      "the Caddyfile has no `handle @dashboard` block this test could read",
    ).not.toBeNull();
    const proxy = /^reverse_proxy[^\n]*\{$([\s\S]*?)^\}$/m.exec(dashboard ?? "")?.[1] ?? "";

    expect(proxy.split("\n").map((line) => line.trim())).toContain(
      "header_up X-Forwarded-For {client_ip}",
    );
  });
});
