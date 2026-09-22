import { describe, expect, it } from "vitest";

import { registrationSubmitLabel, sentConfirmationCopy } from "./registration-form";

describe("registration resend state", () => {
  it("counts the wait the server named, whatever that wait is", () => {
    expect(registrationSubmitLabel("error", 40)).toBe("Try again in 40s");
    expect(registrationSubmitLabel("error", 7)).toBe("Try again in 7s");
    expect(registrationSubmitLabel("error", 510)).toBe("Try again in 9m");
  });

  it("keeps the button working when no wait came back with the answer", () => {
    expect(registrationSubmitLabel("sending", 0)).toBe("Sending…");
    expect(registrationSubmitLabel("sent", 0)).toBe("Resend secure link");
    expect(registrationSubmitLabel("idle", 0)).toBe("Email me a secure link");
    expect(registrationSubmitLabel("error", 0)).toBe("Email me a secure link");
  });

  it("names the submitted address in the sent confirmation", () => {
    expect(sentConfirmationCopy("owner@example.com")).toBe(
      "We sent a secure link to owner@example.com (if the address can receive mail). Open it in this browser to unlock the prompt and report.",
    );
    expect(sentConfirmationCopy("")).toBe(
      "If the address can receive mail, a secure confirmation link has been sent. Open it in this browser to unlock the prompt and report.",
    );
  });
});
