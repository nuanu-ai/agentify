import { describe, expect, it } from "vitest";

import { canLoadStripeSdk } from "./card-signal-ui";

describe("card signal UI safety", () => {
  it("does not load the provider SDK before explicit consent and setup", () => {
    const ready = {
      consented: true,
      clientSecret: "seti_secret_test",
      adapter: "stripe" as const,
      publishableKey: "pk_test_example",
    };
    expect(canLoadStripeSdk(ready)).toBe(true);
    expect(canLoadStripeSdk({ ...ready, consented: false })).toBe(false);
    expect(canLoadStripeSdk({ ...ready, clientSecret: undefined })).toBe(false);
    expect(canLoadStripeSdk({ ...ready, adapter: "local" })).toBe(false);
    expect(canLoadStripeSdk({ ...ready, publishableKey: null })).toBe(false);
  });
});
