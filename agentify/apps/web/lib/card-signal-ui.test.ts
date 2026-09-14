import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CARD_SIGNAL_DISCLOSURES, canLoadStripeSdk } from "./card-signal-ui";

describe("card signal UI safety", () => {
  it("keeps every required disclosure visible as one copy set", () => {
    expect(CARD_SIGNAL_DISCLOSURES).toEqual([
      "No order is created",
      "Nothing will be charged automatically",
      "Any future purchase requires a separate explicit order and confirmation",
      "You can remove the card now",
    ]);
  });

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
    const componentSource = readFileSync(
      new URL("../components/card-signal.tsx", import.meta.url),
      "utf8",
    );
    expect(componentSource).toContain('from "@stripe/stripe-js/pure"');
    expect(componentSource).not.toContain('from "@stripe/stripe-js"');
  });
});
