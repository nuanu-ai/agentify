import { describe, expect, it, vi } from "vitest";

import { verifyTurnstileToken } from "./turnstile";

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("verifyTurnstileToken", () => {
  it("accepts only a successful scan token for the configured hostname", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        response({ success: true, action: "scan", hostname: "agentify.ad" }),
      );

    await expect(
      verifyTurnstileToken({
        token: "token",
        remoteIp: "203.0.113.8",
        secret: "secret",
        expectedHostname: "agentify.ad",
        action: "scan",
        fetchImpl,
      }),
    ).resolves.toBe(true);

    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(String(request.body)).toContain("remoteip=203.0.113.8");
  });

  it.each([
    { success: false, action: "scan", hostname: "agentify.ad" },
    { success: true, action: "login", hostname: "agentify.ad" },
    { success: true, action: "scan", hostname: "evil.example" },
  ])("rejects mismatched verification %#", async (payload) => {
    await expect(
      verifyTurnstileToken({
        token: "token",
        remoteIp: "203.0.113.8",
        secret: "secret",
        expectedHostname: "agentify.ad",
        action: "scan",
        fetchImpl: vi.fn().mockResolvedValue(response(payload)),
      }),
    ).resolves.toBe(false);
  });

  it("fails closed on provider errors", async () => {
    await expect(
      verifyTurnstileToken({
        token: "token",
        remoteIp: "203.0.113.8",
        secret: "secret",
        expectedHostname: "agentify.ad",
        action: "scan",
        fetchImpl: vi.fn().mockRejectedValue(new Error("network")),
      }),
    ).resolves.toBe(false);
  });
});
