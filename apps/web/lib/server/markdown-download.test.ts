import { describe, expect, it } from "vitest";

import { SECURITY_HEADERS } from "./answer-headers";
import { markdownDownloadResponse } from "./markdown-download";

describe("markdownDownloadResponse", () => {
  it("is a private Markdown attachment that no crawler indexes", async () => {
    const response = markdownDownloadResponse(
      "# Safe Agentify prompt\n",
      "agentify complete prompt.md",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="agentify-complete-prompt.md"',
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await response.text()).toBe("# Safe Agentify prompt\n");
  });

  it("leaves the headers every answer carries to the process, which would otherwise send them twice", () => {
    const response = markdownDownloadResponse("# Safe Agentify prompt\n", "prompt.md");

    for (const name of Object.keys(SECURITY_HEADERS)) {
      expect(response.headers.has(name), name).toBe(false);
    }
  });
});
