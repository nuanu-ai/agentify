import { describe, expect, it } from "vitest";

import { errorResponse, requestHeaders, requestId, waitResponse } from "./http";

describe("server HTTP correlation", () => {
  it("keeps one request ID and returns it in the error envelope and header", async () => {
    const request = new Request("https://agentify.ad/api/v1/scans", {
      method: "POST",
      headers: {
        "x-request-id": "019f5b6a-4b9f-7000-8000-000000000001",
      },
    });
    const response = errorResponse(request, 503, "database_unavailable", "Please retry.", true);
    const body = (await response.json()) as {
      error: { request_id: string };
    };

    expect(requestId(request)).toBe(body.error.request_id);
    expect(response.headers.get("x-request-id")).toBe(body.error.request_id);
    expect(requestHeaders(request)["X-Request-Id"]).toBe(body.error.request_id);
  });

  it("leaves Retry-After to the call site that knows the number is a wait", async () => {
    const request = () => new Request("https://agentify.ad/api/v1/scans", { method: "POST" });

    // A hint in the envelope is not an instruction a machine should obey: the
    // status it is waiting on may never change.
    const hint = errorResponse(request(), 409, "report_not_ready", "Not ready.", true, 5);
    expect(hint.headers.get("Retry-After")).toBeNull();
    expect(
      ((await hint.json()) as { error: { retry_after_seconds?: number } }).error
        .retry_after_seconds,
    ).toBe(5);

    const wait = waitResponse(request(), 429, "hard_rate_limit", "Come back later.", 40);
    expect(wait.headers.get("Retry-After")).toBe("40");
    expect(
      ((await wait.json()) as { error: { retry_after_seconds?: number } }).error
        .retry_after_seconds,
    ).toBe(40);
  });

  it("rejects attacker-controlled request ID characters", () => {
    const request = new Request("https://agentify.ad/api/health", {
      headers: { "x-request-id": "owner@example.com/?token=secret" },
    });
    expect(requestId(request)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
