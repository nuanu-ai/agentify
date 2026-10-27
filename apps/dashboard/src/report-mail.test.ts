import { describe, expect, it } from "vitest";
import { reportLinkMessage } from "./report-mail.js";

describe("report link mail", () => {
  it.each([
    [
      "https://agentify.ad/dashboard/sign-in/open?token=a1b2&x=y",
      "https://agentify.ad/dashboard/sign-in/open?token=a1b2&amp;x=y",
    ],
    [
      'https://agentify.ad/dashboard/sign-in/open?token=a&return="><script>alert("x")</script>',
      "https://agentify.ad/dashboard/sign-in/open?token=a&amp;return=&quot;&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    ],
  ])("carries the exact link in text and HTML: %s", (link, escaped) => {
    // A client that draws no button, and a person copying the link by hand,
    // both need the whole of it, and the HTML must carry the same one.
    const message = reportLinkMessage("owner@example.com", link);

    expect(message.to).toBe("owner@example.com");
    expect(message.body.split("\n")).toContain(link);
    expect(message.html).toContain("<!doctype html>");
    expect(message.html).toContain(`href="${escaped}"`);
    expect(message.html).not.toContain("<script>");
  });
});
