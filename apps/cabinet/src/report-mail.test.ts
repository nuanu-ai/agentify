import { describe, expect, it } from "vitest";
import { type ReportMailPurpose, reportLinkMessage } from "./report-mail.js";

const cases = [
  {
    purpose: "registration",
    subject: "Unlock your Agentify report",
    heading: "Your Agentify report is ready",
    detail: "Confirm your email to unlock the AI fix prompt and downloadable Markdown report.",
    action: "Open my report",
  },
  {
    purpose: "recovery",
    subject: "Recover your Agentify report",
    heading: "Recover your Agentify report",
    detail: "If a private report is linked to this address, use this secure link to recover it.",
    action: "Recover report access",
  },
] as const satisfies readonly {
  purpose: ReportMailPurpose;
  subject: string;
  heading: string;
  detail: string;
  action: string;
}[];

describe("report link mail", () => {
  it.each(cases)("keeps the $purpose purpose in equivalent HTML and plain text", (one) => {
    const link = `https://agentify.ad/auth/callback#state=${one.purpose}&token=a_b-c`;
    const message = reportLinkMessage("owner@example.com", one.purpose, link);

    expect(message).toMatchObject({
      to: "owner@example.com",
      subject: one.subject,
    });
    expect(message.body).toContain(one.heading);
    expect(message.body).toContain(one.detail);
    expect(message.body).toContain(`${one.action}:`);
    expect(message.body.split("\n")).toContain(link);
    expect(message.body).toContain("opens once and expires an hour after it was sent");
    expect(message.body).toContain("If you did not ask for it, ignore this message.");

    expect(message.html).toContain("<!doctype html>");
    expect(message.html).toContain(one.heading);
    expect(message.html).toContain(one.detail);
    expect(message.html).toContain(one.action);
    expect(message.html).toContain(link.replaceAll("&", "&amp;"));
    expect(message.html).toContain("opens once and expires an hour after it was sent");
    expect(message.html).toContain(
      "This message was sent because this address was entered at Agentify.",
    );
    expect(message.html).not.toContain("commerce account");
  });

  it("escapes an untrusted report destination without changing its browser destination", () => {
    const link =
      'https://agentify.ad/auth/callback#state=s&token=a&return="><script>alert("x")</script>';
    const message = reportLinkMessage("owner@example.com", "registration", link);

    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain(
      "https://agentify.ad/auth/callback#state=s&amp;token=a&amp;return=&quot;&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    expect(message.body.split("\n")).toContain(link);
  });
});
