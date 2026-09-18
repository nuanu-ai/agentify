import { describe, expect, it } from "vitest";
import { transactionalEmailHtml } from "./mail-template.js";

describe("transactional email HTML", () => {
  it("escapes every piece of message data while keeping the exact link functional", () => {
    const html = transactionalEmailHtml({
      preview: 'Preview <img src=x onerror="preview"> & more',
      eyebrow: "Account <action>",
      title: 'Title <script>alert("title")</script>',
      lead: "Lead & context",
      action: 'Continue <now> & "safely"',
      link: 'https://agentify.example/action?token=a&return="/><script>alert(1)</script>',
      paragraphs: ['Detail <one> & "two"', "Last > first"],
    });

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("Preview &lt;img src=x onerror=&quot;preview&quot;&gt; &amp; more");
    expect(html).toContain("Account &lt;action&gt;");
    expect(html).toContain("Title &lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;");
    expect(html).toContain("Lead &amp; context");
    expect(html).toContain("Continue &lt;now&gt; &amp; &quot;safely&quot;");
    expect(html).toContain(
      'href="https://agentify.example/action?token=a&amp;return=&quot;/&gt;&lt;script&gt;alert(1)&lt;/script&gt;"',
    );
    expect(html).toContain("Detail &lt;one&gt; &amp; &quot;two&quot;");
    expect(html).toContain("Last &gt; first");
  });

  it("has no remote image, stylesheet or font dependency for critical content", () => {
    const html = transactionalEmailHtml({
      preview: "Preview",
      eyebrow: "Account action",
      title: "Continue",
      lead: "Use the link below.",
      action: "Continue",
      link: "https://agentify.example/action?token=abc",
      paragraphs: ["The link expires in an hour."],
    });

    expect(html).not.toMatch(/<(?:img|link)\b/i);
    expect(html).not.toMatch(/url\s*\(/i);
    expect(html).toContain("-apple-system");
    expect(html).toContain("https://agentify.example/action?token=abc");
  });

  it("uses a product-wide Agentify footer", () => {
    const html = transactionalEmailHtml({
      preview: "Preview",
      eyebrow: "Secure access",
      title: "Continue",
      lead: "Use the link below.",
      action: "Continue",
      link: "https://agentify.ad/action?token=abc",
      paragraphs: ["The link expires in an hour."],
    });

    expect(html).toContain("Agentify secure access message");
    expect(html).not.toContain("commerce account");
  });
});
