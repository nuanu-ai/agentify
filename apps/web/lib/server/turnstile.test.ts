import { describe, expect, it } from "vitest";

import { verifyTurnstileToken } from "./turnstile";

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("verifyTurnstileToken", () => {
  it("accepts only a successful scan token for the configured hostname", async () => {
    let providerRequest: RequestInit | undefined;
    const fetchImpl = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      providerRequest = init;
      return response({
        success: true,
        action: "scan",
        hostname: "agentify.ad",
      });
    };

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

    expect(String(providerRequest?.body)).toContain("remoteip=203.0.113.8");
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
        fetchImpl: async () => response(payload),
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
        fetchImpl: async () => {
          throw new Error("network");
        },
      }),
    ).resolves.toBe(false);
  });
});
