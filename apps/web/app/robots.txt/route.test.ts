import { parseRobots } from "@agentify/scanner";
import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("GET /robots.txt", () => {
  it("returns a parseable text policy", async () => {
    const response = GET();
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(parseRobots(body)).toMatchObject({
      fatal: false,
      contentSignalMalformed: false,
    });
  });
});
