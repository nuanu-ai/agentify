/**
 * Only the values that decide where a merchant's browser is sent, or without
 * which the dashboard cannot work at all, are checked here: a wrong mount point
 * fails quietly, by pointing every link and redirect somewhere the dashboard is
 * not.
 */

import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { TEST_AUTH_SECRET } from "./testing/secrets.js";

const REQUIRED = {
  DATABASE_URL: "postgres://agentify:agentify@postgres:5432/agentify",
  AUTH_SECRET: TEST_AUTH_SECRET,
  PAYMENT_NETWORK: "eip155:84532",
  FACILITATOR_URL: "sandbox:scripted",
};

const given = (environment: Record<string, string> = {}): Record<string, string> => ({
  ...REQUIRED,
  ...environment,
});

describe("Google sign-in configuration", () => {
  const google = {
    GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "a-synthetic-google-client-secret",
  };

  it("keeps email sign-in available when Google is not configured", () => {
    expect(loadConfig(given()).google).toBeNull();
    expect(loadConfig(given({ GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" })).google).toBeNull();
  });

  it("accepts complete credentials for local development and secure public sites", () => {
    expect(loadConfig(given(google)).google).toEqual({
      clientId: google.GOOGLE_CLIENT_ID,
      clientSecret: google.GOOGLE_CLIENT_SECRET,
    });
    expect(
      loadConfig(
        given({ ...google, PUBLIC_BASE_URL: "https://test.agentify.ad", COOKIE_SECURE: "true" }),
      ).google,
    ).not.toBeNull();
  });

  it("refuses either missing credential and never prints the credential supplied", () => {
    for (const missing of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const) {
      const incomplete = { ...google, [missing]: "" };
      let said = "";
      try {
        loadConfig(given(incomplete));
      } catch (error) {
        said = String(error);
      }
      expect(said).toContain(missing);
      expect(said).not.toContain(google.GOOGLE_CLIENT_ID);
      expect(said).not.toContain(google.GOOGLE_CLIENT_SECRET);
    }
  });

  it("refuses whitespace credentials rather than offering a sign-in that cannot work", () => {
    for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) {
      expect(() => loadConfig(given({ ...google, [name]: " " }))).toThrow(name);
    }
  });

  it("requires HTTPS and secure cookies for Google on a public site", () => {
    expect(() =>
      loadConfig(
        given({ ...google, PUBLIC_BASE_URL: "http://test.agentify.ad", COOKIE_SECURE: "true" }),
      ),
    ).toThrow(/PUBLIC_BASE_URL/);
    expect(() =>
      loadConfig(given({ ...google, PUBLIC_BASE_URL: "https://test.agentify.ad" })),
    ).toThrow(/COOKIE_SECURE/);
  });
});

describe("what the dashboard will not start without", () => {
  it("starts the private report listener only with its own complete secret", () => {
    expect(loadConfig(given()).reportIdentitySecret).toBeNull();
    expect(loadConfig(given({ REPORT_IDENTITY_SECRET: "" })).reportIdentitySecret).toBeNull();
    expect(() => loadConfig(given({ REPORT_IDENTITY_SECRET: "short" }))).toThrow(
      /REPORT_IDENTITY_SECRET/,
    );
    expect(() => loadConfig(given({ REPORT_IDENTITY_SECRET: REQUIRED.AUTH_SECRET }))).toThrow(
      /REPORT_IDENTITY_SECRET/,
    );
    expect(
      loadConfig(
        given({ REPORT_IDENTITY_SECRET: "a-dedicated-private-secret-at-least-32-characters" }),
      ).reportIdentitySecret,
    ).toBe("a-dedicated-private-secret-at-least-32-characters");
  });

  it("refuses to start with nothing to sign a session with", () => {
    // The sign-in component's own fallback is a value written in public source.
    const { AUTH_SECRET: _absent, ...withoutSecret } = given();

    expect(() => loadConfig(withoutSecret)).toThrow(/AUTH_SECRET/);
    expect(() => loadConfig(given({ AUTH_SECRET: "too short" }))).toThrow(/AUTH_SECRET/);
  });

  it("refuses to start with no database to keep its accounts and sessions in", async () => {
    // With no database there is nowhere to look a session up, so the dashboard
    // would draw a sign-in form it can never accept.
    const { DATABASE_URL: _absent, ...withoutDatabase } = given();

    expect(() => loadConfig(withoutDatabase)).toThrow(/DATABASE_URL/);
  });

  it("does not refuse a key it is handed anyway, because it is not its business", () => {
    // A leftover variable in a compose file must not stop the dashboard.
    expect(() => loadConfig(given({ MERCHANT_API_KEY: "short" }))).not.toThrow();
  });
});

describe("the dashboard is told which stack it is in front of", () => {
  const required = {
    DATABASE_URL: "postgres://agentify@localhost:5432/agentify",
    AUTH_SECRET: "a-secret-that-is-at-least-thirty-two-characters",
    PAYMENT_NETWORK: "eip155:84532",
    FACILITATOR_URL: "sandbox:scripted",
  };

  it("runs the same derivation its gateway runs", () => {
    // Otherwise the dashboard could label a stack differently from its gateway
    // and tell a merchant something false about their money.
    expect(loadConfig(required).surfaceMode).toBe("sandbox");
    expect(
      loadConfig({ ...required, FACILITATOR_URL: "https://x402.org/facilitator" }).surfaceMode,
    ).toBe("test");
    expect(
      loadConfig({
        ...required,
        PAYMENT_NETWORK: "eip155:8453",
        FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
      }).surfaceMode,
    ).toBe("live");
  });

  it("refuses to start when it was handed no chain", () => {
    const { PAYMENT_NETWORK, ...withoutChain } = required;
    expect(() => loadConfig(withoutChain)).toThrowError(/PAYMENT_NETWORK.*not set/s);
  });

  it("refuses to start when it was handed no facilitator", () => {
    const { FACILITATOR_URL, ...withoutFacilitator } = required;
    expect(() => loadConfig(withoutFacilitator)).toThrowError(/FACILITATOR_URL.*not set/s);
  });

  it("gives neither a default, unlike the gateway", () => {
    // A live dashboard falling back to a test chain would print, over a
    // merchant's real receipts, that none of the money is real.
    expect(() =>
      loadConfig({ DATABASE_URL: required.DATABASE_URL, AUTH_SECRET: required.AUTH_SECRET }),
    ).toThrow();
  });

  it("refuses a chain on neither written list", () => {
    expect(() => loadConfig({ ...required, PAYMENT_NETWORK: "eip155:1" })).toThrow();
  });
});

describe("where the dashboard thinks it is mounted", () => {
  it("takes a path, and takes being at the root of its origin", () => {
    expect(loadConfig(given()).basePath).toBe("");
    expect(loadConfig(given({ BASE_PATH: "/dashboard" })).basePath).toBe("/dashboard");
  });

  it("refuses a value that would send every link to another host", () => {
    // "//evil.com" is a protocol-relative URL to a browser, and a backslash
    // after the first slash counts as a second slash, so each would send every
    // redirect, with the session cookie following it, to another host.
    for (const bad of ["//evil.com", "//evil.com/dashboard", "/\\evil.com", "/\\\\evil.com"]) {
      expect(() => loadConfig(given({ BASE_PATH: bad })), bad).toThrow(/BASE_PATH/);
    }
    expect(new URL("/\\evil.com", "https://dashboard.example/").host).toBe("evil.com");
  });

  it("refuses a mount point that is not one", () => {
    // A trailing slash would double up against every path built from it, a
    // query or fragment is not a mount point, and a bare word is a relative
    // path.
    for (const bad of [
      "/dashboard/",
      "dashboard",
      "/dash board",
      "/dashboard?x=1",
      "/dashboard#top",
    ]) {
      expect(() => loadConfig(given({ BASE_PATH: bad })), bad).toThrow(/BASE_PATH/);
    }
  });

  it("names every problem at once rather than one per restart", () => {
    const thrown = (): string => {
      try {
        loadConfig({ BASE_PATH: "//evil.com", COOKIE_SECURE: "no" });
        return "";
      } catch (error) {
        return String(error);
      }
    };

    const said = thrown();
    expect(said).toContain("BASE_PATH");
    expect(said).toContain("COOKIE_SECURE");
    expect(said).toContain("DATABASE_URL");
  });
});

describe("where the dashboard's two messages go", () => {
  it("sends nothing anywhere unless a deployment says where", () => {
    const config = loadConfig(given());
    expect(config.mailUrl).toBe("sandbox:log");
    expect(config.mailFrom).toMatch(/^Agentify </);
  });

  it("refuses a real credential beside the word that means nothing is sent", () => {
    // Most likely a production environment file copied onto a sandbox.
    expect(() => loadConfig(given({ MAIL_API_KEY: "re_a_real_looking_key" }))).toThrow(
      /MAIL_API_KEY/,
    );
  });

  it("reads a credential set to nothing the way it reads one never set", () => {
    // A compose file writes "no provider here" as the name with nothing after
    // it.
    expect(loadConfig(given({ MAIL_API_KEY: "", MAIL_FROM: "" })).mailUrl).toBe("sandbox:log");
    // A one-character credential is still a credential.
    expect(() => loadConfig(given({ MAIL_API_KEY: " " }))).toThrow(/MAIL_API_KEY/);
  });

  it("refuses a provider it could not authenticate against, or send from", () => {
    // A provider with no key would appear to send mail and silently not.
    expect(() =>
      loadConfig(
        given({
          MAIL_URL: "https://api.resend.com",
          MAIL_FROM: "Agentify <no-reply@mail.example.com>",
          PUBLIC_BASE_URL: "https://agentify.example",
        }),
      ),
    ).toThrow(/MAIL_API_KEY/);
    expect(() =>
      loadConfig(
        given({
          MAIL_URL: "https://api.resend.com",
          MAIL_API_KEY: "re_a_real_looking_key",
          PUBLIC_BASE_URL: "https://agentify.example",
        }),
      ),
    ).toThrow(/MAIL_FROM/);
  });

  it("refuses to send real mail whose links point at the reader's own computer", () => {
    // The localhost default would send every merchant a link into their own
    // machine.
    expect(() =>
      loadConfig(
        given({
          MAIL_URL: "https://api.resend.com",
          MAIL_API_KEY: "re_a_real_looking_key",
          MAIL_FROM: "Agentify <no-reply@mail.example.com>",
        }),
      ),
    ).toThrow(/PUBLIC_BASE_URL/);
  });

  it("takes a provider that is set up properly", () => {
    const config = loadConfig(
      given({
        MAIL_URL: "https://api.resend.com",
        MAIL_API_KEY: "re_a_real_looking_key",
        MAIL_FROM: "Agentify <no-reply@mail.example.com>",
        PUBLIC_BASE_URL: "https://agentify.example/",
      }),
    );

    expect(config.mailUrl).toBe("https://api.resend.com");
    // A path is joined onto this, so a trailing slash would double up.
    expect(config.publicBaseUrl).toBe("https://agentify.example");
  });
});

describe("what the configuration says about itself", () => {
  it("does not put the database password into the sentence it throws", () => {
    // A startup failure goes to a log, so it names the variable and never the
    // secret's value.
    const thrown = (): string => {
      try {
        loadConfig({
          ...given({ COOKIE_SECURE: "no" }),
          DATABASE_URL: "postgres://agentify:s3cret-database-password@postgres:5432/agentify",
        });
        return "";
      } catch (error) {
        return String(error);
      }
    };

    const said = thrown();
    expect(said).toContain("COOKIE_SECURE");
    expect(said).not.toContain("s3cret-database-password");
  });

  it("does not put what it signs sessions with into the sentence it throws", () => {
    const thrown = (): string => {
      try {
        loadConfig({
          ...given({ COOKIE_SECURE: "no" }),
          AUTH_SECRET: "s3cret-signing-value-of-at-least-32-characters",
        });
        return "";
      } catch (error) {
        return String(error);
      }
    };

    const said = thrown();
    expect(said).toContain("COOKIE_SECURE");
    expect(said).not.toContain("s3cret-signing-value-of-at-least-32-characters");
  });
});
