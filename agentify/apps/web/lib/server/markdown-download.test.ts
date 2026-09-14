import { describe, expect, it } from "vitest";

import { markdownDownloadResponse } from "./markdown-download";

describe("markdownDownloadResponse", () => {
  it("returns a non-sniffable private HTTPS attachment", async () => {
    const response = markdownDownloadResponse(
      "# Safe Agentify prompt\n",
      "agentify complete prompt.md",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="agentify-complete-prompt.md"',
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await response.text()).toBe("# Safe Agentify prompt\n");
  });
});
