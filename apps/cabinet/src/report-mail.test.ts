import { describe, expect, it } from "vitest";
import { reportLinkMessage } from "./report-mail.js";

describe("report link mail", () => {
  it("carries the whole link on a line of its own in text and as the button in HTML", () => {
    // A client that draws no button, and a person copying the link by hand,
    // both need the whole of it, and the HTML must carry the same one.
    const link = "https://agentify.ad/cabinet/sign-in/open?token=a1b2&x=y";
    const message = reportLinkMessage("owner@example.com", link);

    expect(message.to).toBe("owner@example.com");
    expect(message.body.split("\n")).toContain(link);
    expect(message.html).toContain("<!doctype html>");
    expect(message.html).toContain(link.replaceAll("&", "&amp;"));
  });

  it("escapes an untrusted link without changing where it leads", () => {
    const link =
      'https://agentify.ad/cabinet/sign-in/open?token=a&return="><script>alert("x")</script>';
    const message = reportLinkMessage("owner@example.com", link);

    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain(
      "https://agentify.ad/cabinet/sign-in/open?token=a&amp;return=&quot;&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    expect(message.body.split("\n")).toContain(link);
  });
});
