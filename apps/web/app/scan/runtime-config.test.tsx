import { afterEach, describe, expect, it } from "vitest";

import ScanPage from "./[id]/page";
import PendingScanPage from "./pending/page";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function configureRuntime(overrides: Record<string, string | undefined>) {
  Object.assign(process.env, {
    DATABASE_URL: "postgresql://scanner:scanner@localhost:5432/scanner",
    REGISTRATION_ENABLED: "false",
    TURNSTILE_SITE_KEY: "",
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

  it("passes the runtime Turnstile site key into the browser experience", () => {
    configureRuntime({ TURNSTILE_SITE_KEY: "runtime-test-site-key" });
    const configured = PendingScanPage();
    configureRuntime({ TURNSTILE_SITE_KEY: "" });
    const absent = PendingScanPage();

    expect(configured.props.turnstileSiteKey).toBe("runtime-test-site-key");
    expect(absent.props.turnstileSiteKey).toBeNull();
  });
});
