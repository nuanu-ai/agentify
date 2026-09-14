import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("GET /llms.txt", () => {
  it("returns the versioned public-page index as text", async () => {
    const response = GET();
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(body).toMatch(/^# Agentify$/m);
    expect(body).toMatch(/\[[^\]]+\]\(https?:\/\/[^)]+\)/);
  });
});
