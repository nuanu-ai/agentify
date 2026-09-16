import { afterEach, describe, expect, it, vi } from "vitest";

import { sendTransactionalEmail, trySendTransactionalEmail } from "./email";

const message = {
  to: "recipient@example.com",
  subject: "Report ready",
  text: "Open the report.",
  html: "<p>Open the report.</p>",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("report email fail-open delivery", () => {
  it("returns control when the post-verification report email fails", async () => {
    const sender = vi.fn().mockRejectedValue(new Error("provider_down"));
    await expect(trySendTransactionalEmail(message, sender)).resolves.toBe(
      false,
    );
    expect(sender).toHaveBeenCalledOnce();
  });

  it("reports successful delivery without changing the verification result", async () => {
    const sender = vi.fn().mockResolvedValue(undefined);
    await expect(trySendTransactionalEmail(message, sender)).resolves.toBe(
      true,
    );
  });
});

describe("transactional email sender", () => {
  it("hands Resend the configured address with the Agentify display name", async () => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://user:pass@localhost:5432/agentify",
    );
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("RESEND_FROM", "reports@agentify.ad");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "provider-message-id" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await sendTransactionalEmail(message);

    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      from: "Agentify <reports@agentify.ad>",
    });
  });
});
