import { describe, expect, it, vi } from "vitest";

import { trySendTransactionalEmail } from "./email";

const message = {
  to: "recipient@example.com",
  subject: "Report ready",
  text: "Open the report.",
  html: "<p>Open the report.</p>",
};

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
