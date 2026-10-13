import { afterEach, describe, expect, it } from "vitest";

import ScanPage from "./[id]/page";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function configureRuntime(overrides: Record<string, string | undefined>) {
  Object.assign(process.env, {
    DATABASE_URL: "postgresql://scanner:scanner@localhost:5432/scanner",
    REGISTRATION_ENABLED: "false",
    ...overrides,
  });
}

describe("scanner public runtime configuration", () => {
  it("uses the server registration switch for the private scan page", async () => {
    configureRuntime({ REGISTRATION_ENABLED: "true" });
    const enabled = await ScanPage({
      params: Promise.resolve({ id: "scan-1" }),
      searchParams: Promise.resolve({}),
    });
    configureRuntime({ REGISTRATION_ENABLED: "false" });
    const disabled = await ScanPage({
      params: Promise.resolve({ id: "scan-1" }),
      searchParams: Promise.resolve({}),
    });

    expect(enabled.props.registrationEnabled).toBe(true);
    expect(disabled.props.registrationEnabled).toBe(false);
  });
});
