import { describe, expect, it } from "vitest";

import {
  classifyHttpRoute,
  createLogger,
  safeErrorCode,
  safeErrorType,
  sanitizeLogAttributes,
} from "./index.js";

describe("structured observability", () => {
  it("emits stable JSON and drops PII, URLs, tokens, stacks and unknown fields", () => {
    const lines: string[] = [];
    const logger = createLogger({
      service: "web",
      environment: "test",
      now: () => new Date("2026-07-17T00:00:00.000Z"),
      sink: (line) => lines.push(line),
    });

    logger.error("api_error", {
      request_id: "019f5b6a-4b9f-7000-8000-000000000001",
      route: "api_v1_scans_create",
      status_code: 503,
      error_code: "database_unavailable",
      email: "owner@example.com",
      target_url: "https://secret.example/?token=secret",
      stack: "secret stack",
      error_type: "DatabaseError",
    });

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(record).toMatchObject({
      schema: "agentify-log-v1",
      timestamp: "2026-07-17T00:00:00.000Z",
      level: "error",
      service: "web",
      environment: "test",
      event: "api_error",
      route: "api_v1_scans_create",
      status_code: 503,
      suppressed_count: 3,
    });
    expect(JSON.stringify(record)).not.toMatch(
      /owner@|secret\.example|token=|secret stack/i,
    );
  });

  it("rejects URL-shaped values even under an allowed key", () => {
    expect(
      sanitizeLogAttributes({ error_code: "https://secret.example/?x=1" }),
    ).toEqual({ suppressed_count: 1 });
  });

  it("extracts only the safe error class", () => {
    const error = new Error("https://secret.example/?token=x");
    error.name = "ProviderTimeout";
    expect(safeErrorType(error)).toBe("ProviderTimeout");
    expect(safeErrorType("secret")).toBe("UnknownError");
    expect(safeErrorCode({ code: "SELF_SIGNED_CERT_IN_CHAIN" })).toBe(
      "SELF_SIGNED_CERT_IN_CHAIN",
    );
    expect(safeErrorCode({ errors: [{ code: "ECONNRESET" }] })).toBe(
      "ECONNRESET",
    );
    expect(safeErrorCode({ code: "https://secret.example/?token=x" })).toBe(
      undefined,
    );
  });

  it("classifies dynamic capability paths without returning identifiers", () => {
    expect(
      classifyHttpRoute(
        "/api/v1/scans/019f5b6a-4b9f-7000-8000-000000000001/status",
      ),
    ).toBe("api_v1_scan_status");
    expect(classifyHttpRoute("/s/public-secret-slug")).toBe("page_share");
    expect(classifyHttpRoute("/owner@example.com")).toBe("other");
  });
});
