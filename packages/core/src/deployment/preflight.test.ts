/**
 * The release refusing a channel that is not what it says it is.
 *
 * Everything here is text: the fixtures are what `docker compose config
 * --format json` printed for the two channels, and every case below is that
 * document with one thing changed. The doing — build, up, the curls against a
 * live host — is a shell script talking to one Docker daemon and is not
 * pretended about here.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ResolvedCompose } from "./preflight.d.mts";
import { problemsWith } from "./preflight.mjs";

const fixture = (name: string): ResolvedCompose =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const envFor = (resolved: ResolvedCompose, service: string): Record<string, string | undefined> => {
  const environment = resolved.services[service]?.environment;
  if (environment === undefined) {
    throw new Error(`the fixture has no ${service} environment`);
  }
  return environment;
};

const TEST_CHANNEL = fixture("test-channel");
const PRODUCTION_CHANNEL = fixture("live-channel");

/** The release entry point, run in a separate Node process with controlled stdin. */
const runCli = (channel: string, input: string) =>
  spawnSync(process.execPath, [new URL("./preflight.mjs", import.meta.url).pathname, channel], {
    encoding: "utf8",
    input,
  });

/** Values a public preflight diagnostic must never repeat from a fixture. */
const expectNoFixtureSecrets = (stderr: string, resolved: ResolvedCompose): void => {
  const values = [
    resolved.services.gateway.environment?.REGISTRATION_INVITATION,
    resolved.services.gateway.environment?.CDP_API_KEY_ID,
    resolved.services.gateway.environment?.CDP_API_KEY_SECRET,
    resolved.services.cabinet.environment?.AUTH_SECRET,
    resolved.services.cabinet.environment?.ANNOUNCEMENT_SECRET,
  ];
  for (const value of values) {
    if (value !== undefined && value !== "") {
      expect(stderr).not.toContain(value);
    }
  }
};

/** The document with one service's one variable changed, or taken away. */
const withEnv = (
  resolved: ResolvedCompose,
  service: string,
  name: string,
  value: string | null,
): ResolvedCompose => {
  const next = structuredClone(resolved);
  const environment = next.services[service]?.environment;
  if (environment === undefined) {
    throw new Error(`the fixture has no ${service} service to change`);
  }
  if (value === null) {
    delete environment[name];
  } else {
    environment[name] = value;
  }
  return next;
};

describe("a channel that is what it claims to be", () => {
  it("accepts production only with a private, consistently credentialed database", () => {
    expect(problemsWith("production", PRODUCTION_CHANNEL)).toEqual([]);
  });

  it("accepts test only on the existing test ingress binding", () => {
    expect(problemsWith("test", TEST_CHANNEL)).toEqual([]);
  });

  it("accepts the test door on another private address, and on no public or guessed one", () => {
    const binding = (host_ip: string | undefined) => {
      const moved = structuredClone(TEST_CHANNEL);
      moved.services.web.ports = [
        { mode: "ingress", host_ip, target: 443, published: "8443", protocol: "tcp" },
      ];
      return moved;
    };

    expect(problemsWith("test", binding("10.77.0.9"))).toEqual([]);
    for (const unsafe of [undefined, "", "0.0.0.0", "203.0.113.9", "10.20.10.256"]) {
      expect(problemsWith("test", binding(unsafe))).toContainEqual(
        expect.stringMatching(/private IPv4/),
      );
    }
  });

  it.each([
    ["production", PRODUCTION_CHANNEL],
    ["test", TEST_CHANNEL],
  ] as const)("refuses a static deployed root in %s", (channel, config) => {
    for (const value of [null, "some_other_front_page"]) {
      expect(
        problemsWith(channel, withEnv(config, "web", "AGENTIFY_FRONT_PAGE", value)).join("\n"),
      ).toMatch(/AGENTIFY_FRONT_PAGE/);
    }
  });

  it("refuses retired channel names", () => {
    expect(problemsWith("retired-test", TEST_CHANNEL)).toContainEqual(
      expect.stringMatching(/not a release channel/),
    );
    expect(problemsWith("retired-live", PRODUCTION_CHANNEL)).toContainEqual(
      expect.stringMatching(/not a release channel/),
    );
  });

  it("refuses production when its Caddy publishes a host port or leaves the ingress network", () => {
    const exposed = structuredClone(PRODUCTION_CHANNEL);
    exposed.services.web.ports = [
      { mode: "ingress", host_ip: "0.0.0.0", target: 8080, published: "8080", protocol: "tcp" },
    ];
    expect(problemsWith("production", exposed).join("\n")).toMatch(/published bindings/);

    const disconnected = structuredClone(PRODUCTION_CHANNEL);
    disconnected.services.web.networks = { default: {} };
    expect(problemsWith("production", disconnected).join("\n")).toMatch(/agentify-ingress/);

    const wrongAlias = structuredClone(PRODUCTION_CHANNEL);
    wrongAlias.services.web.networks = { "agentify-ingress": { aliases: ["web"] } };
    expect(problemsWith("production", wrongAlias).join("\n")).toMatch(/agentify-web/);
  });

  it("trusts only the exact edge peer to carry browser scheme and client address", () => {
    for (const cidr of ["private_ranges", "172.30.80.0/24", "0.0.0.0/0", ""]) {
      expect(
        problemsWith(
          "production",
          withEnv(PRODUCTION_CHANNEL, "web", "AGENTIFY_TRUSTED_EDGE_CIDR", cidr),
        ).join("\n"),
      ).toMatch(/AGENTIFY_TRUSTED_EDGE_CIDR/);
    }
  });

  it("refuses test on a public listener or an old public origin", () => {
    const exposed = structuredClone(TEST_CHANNEL);
    exposed.services.web.ports = [
      { mode: "ingress", host_ip: "0.0.0.0", target: 443, published: "8443", protocol: "tcp" },
    ];
    expect(problemsWith("test", exposed).join("\n")).toMatch(/private IPv4/);
    expect(
      problemsWith(
        "test",
        withEnv(TEST_CHANNEL, "cabinet", "PUBLIC_BASE_URL", "https://wrong.example"),
      ).join("\n"),
    ).toMatch(/PUBLIC_BASE_URL/);
  });

  it("refuses old/default database credentials or a differently wired process without printing secrets", () => {
    for (const change of [
      (wrong: ResolvedCompose) => {
        envFor(wrong, "postgres").POSTGRES_PASSWORD = "agentify";
      },
      (wrong: ResolvedCompose) => {
        envFor(wrong, "postgres").POSTGRES_PASSWORD =
          "REPLACE_WITH_NEW_HEX_PASSWORD_AT_LEAST_24_CHARACTERS";
      },
      (wrong: ResolvedCompose) => {
        envFor(wrong, "cabinet").DATABASE_URL =
          "postgres://agentify:other-secret@postgres:5432/agentify";
      },
      (wrong: ResolvedCompose) => {
        envFor(wrong, "migrate").DATABASE_URL =
          "postgres://agentify:other-secret@postgres:5432/agentify";
      },
      (wrong: ResolvedCompose) => {
        envFor(wrong, "scanner-worker").DATABASE_URL = envFor(
          wrong,
          "scanner-worker",
        ).DATABASE_URL?.replace(/\/agentify$/, "/agentify_scanner");
      },
    ]) {
      const wrong = structuredClone(PRODUCTION_CHANNEL);
      change(wrong);
      const problems = problemsWith("production", wrong).join("\n");
      expect(problems).toMatch(/postgres|DATABASE_URL/);
      expect(problems).not.toContain("synthetic-new-database-password");
      expect(problems).not.toContain("other-secret");
    }
  });

  it("refuses unresolved production environment placeholders", () => {
    const wrong = withEnv(
      PRODUCTION_CHANNEL,
      "cabinet",
      "AUTH_SECRET",
      "REPLACE_FROM_EXISTING_LIVE_CONFIG",
    );
    expect(problemsWith("production", wrong)).toContainEqual(
      expect.stringMatching(/AUTH_SECRET.*placeholder/),
    );
  });

  it("refuses a live production cabinet that logs reset links or names a local mail sender", () => {
    for (const [name, value] of [
      ["MAIL_URL", "sandbox:log"],
      ["MAIL_FROM", "Agentify <no-reply@localhost>"],
      ["MAIL_FROM", "no-reply@127.0.0.1"],
    ] as const) {
      const wrong = withEnv(PRODUCTION_CHANNEL, "cabinet", name, value);
      const problems = problemsWith("production", wrong).join("\n");
      expect(problems).toMatch(new RegExp(name));
      expect(problems).not.toContain(value);
    }
  });

  it("refuses an absent or empty live mail provider, key or sender", () => {
    for (const name of ["MAIL_URL", "MAIL_API_KEY", "MAIL_FROM"]) {
      for (const value of [null, "", " "]) {
        const wrong = withEnv(PRODUCTION_CHANNEL, "cabinet", name, value);
        expect(problemsWith("production", wrong)).toContainEqual(expect.stringMatching(name));
      }
    }
  });

  it("refuses each channel's configuration presented as the other", () => {
    // The negative control for the whole file: if this passed, every check
    // below would be reading something that is not the channel.
    expect(problemsWith("production", TEST_CHANNEL).length).toBeGreaterThan(0);
    expect(problemsWith("test", PRODUCTION_CHANNEL).length).toBeGreaterThan(0);
  });
});

describe("the chain and the facilitator together", () => {
  // Prevents a public channel claiming settlement while its chain/facilitator pair cannot settle.
  it("refuses the test channel on the scripted facilitator", () => {
    const wrong = withEnv(TEST_CHANNEL, "gateway", "FACILITATOR_URL", "sandbox:scripted");
    expect(problemsWith("test", wrong)).toContainEqual(expect.stringMatching(/FACILITATOR_URL/));
  });

  it("refuses the live channel on the public facilitator", () => {
    const wrong = withEnv(
      PRODUCTION_CHANNEL,
      "gateway",
      "FACILITATOR_URL",
      "https://x402.org/facilitator",
    );
    expect(problemsWith("production", wrong)).toContainEqual(
      expect.stringMatching(/FACILITATOR_URL/),
    );
  });

  it("refuses the live channel with either credential missing", () => {
    for (const name of ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET"]) {
      const wrong = withEnv(PRODUCTION_CHANNEL, "gateway", name, null);
      expect(problemsWith("production", wrong)).toContainEqual(expect.stringMatching(name));
    }
  });

  it("refuses the test channel with either live credential set", () => {
    for (const name of ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET"]) {
      const wrong = withEnv(TEST_CHANNEL, "gateway", name, `synthetic-${name.toLowerCase()}`);
      expect(problemsWith("test", wrong)).toContainEqual(expect.stringMatching(name));
    }
  });

  it("refuses a chain neither channel declared", () => {
    const wrong = withEnv(TEST_CHANNEL, "gateway", "PAYMENT_NETWORK", "eip155:11155111");
    expect(problemsWith("test", wrong)).toContainEqual(expect.stringMatching(/PAYMENT_NETWORK/));
  });
});

describe("the surface mode agrees with the channel", () => {
  // Prevents payment pages asserting the opposite of the settlement environment.
  it("refuses a test stack telling readers it is live", () => {
    const wrong = withEnv(TEST_CHANNEL, "web", "AGENTIFY_SURFACE_MODE", "live");
    expect(problemsWith("test", wrong)).toContainEqual(
      expect.stringMatching(/AGENTIFY_SURFACE_MODE/),
    );
  });

  it("refuses a live stack telling readers it is a sandbox", () => {
    const wrong = withEnv(PRODUCTION_CHANNEL, "web", "AGENTIFY_SURFACE_MODE", "sandbox");
    expect(problemsWith("production", wrong)).toContainEqual(
      expect.stringMatching(/AGENTIFY_SURFACE_MODE/),
    );
  });
});

describe("the cabinet was handed the gateway's pair", () => {
  // Prevents a cabinet describing another settlement path than the gateway executes.
  it("refuses a cabinet on a different facilitator from its gateway", () => {
    const wrong = withEnv(TEST_CHANNEL, "cabinet", "FACILITATOR_URL", "sandbox:scripted");
    expect(problemsWith("test", wrong)).toContainEqual(expect.stringMatching(/cabinet/));
  });

  it("refuses a cabinet on a different chain from its gateway", () => {
    const wrong = withEnv(TEST_CHANNEL, "cabinet", "PAYMENT_NETWORK", "eip155:8453");
    expect(problemsWith("test", wrong)).toContainEqual(expect.stringMatching(/cabinet/));
  });

  it("refuses a cabinet whose public origin does not name the gateway's door", () => {
    // Prevents a merchant who signed into the cabinet being sent to a different public site.
    const wrong = withEnv(TEST_CHANNEL, "cabinet", "PUBLIC_BASE_URL", "http://localhost:8080");
    expect(problemsWith("test", wrong)).toContainEqual(expect.stringMatching(/PUBLIC_BASE_URL/));
  });
});

describe("the mock merchant is not among the services", () => {
  // Prevents the laptop fixture catalog from blocking or contaminating a public deployment.
  it("refuses a configuration where the profile was edited away", () => {
    const wrong = structuredClone(TEST_CHANNEL);
    wrong.services.merchant = { image: "agentify-app" };
    expect(problemsWith("test", wrong)).toContainEqual(expect.stringMatching(/merchant/));
  });
});

describe("a deployed channel seeds no merchant", () => {
  // A merchant comes into being one way: a person opens the link mailed to
  // their address and presses the cabinet's one control (ADR-0014). A key the
  // gateway seeds from a host's file at every start would be a second way, and
  // one nobody can retire without a release.
  const CHANNELS = [
    ["production", PRODUCTION_CHANNEL, "csk_live_"],
    ["test", TEST_CHANNEL, "csk_test_"],
  ] as const;

  it.each(CHANNELS)("accepts %s with nothing to seed", (channel, config) => {
    for (const nothing of [null, ""]) {
      expect(
        problemsWith(channel, withEnv(config, "gateway", "SANDBOX_MERCHANT_KEY", nothing)),
      ).toEqual([]);
    }
  });

  it.each(CHANNELS)(
    "refuses %s seeding a key, names the mailed link, and does not print the key",
    (channel, config, prefix) => {
      // The channel's own prefix and the laptop's key alike: the reason is the
      // second way in, not whose key it is.
      for (const key of [`${prefix}${"x".repeat(44)}`, "csk_test_local-sandbox-merchant-key"]) {
        const problems = problemsWith(
          channel,
          withEnv(config, "gateway", "SANDBOX_MERCHANT_KEY", key),
        );
        expect(problems).toContainEqual(expect.stringMatching(/^gateway: SANDBOX_MERCHANT_KEY/));
        const said = problems.join("\n");
        expect(said).toMatch(/link mailed/);
        expect(said).toMatch(/AGENTIFY_SEED_KEY/);
        expect(said).not.toContain(key);
      }
    },
  );
});

describe("no laptop default survived", () => {
  // Prevents public exposure of a database, published defaults, and a dead public door.
  it("refuses PostgreSQL published to the host", () => {
    const wrong = structuredClone(TEST_CHANNEL);
    wrong.services.postgres.ports = [
      { mode: "ingress", target: 5432, published: "5432", protocol: "tcp" },
    ];
    expect(problemsWith("test", wrong)).toContainEqual(expect.stringMatching(/postgres/));
  });

  it("refuses the cabinet's signing secret written in this repository", () => {
    const wrong = withEnv(
      TEST_CHANNEL,
      "cabinet",
      "AUTH_SECRET",
      "a-sandbox-secret-nobody-should-reuse-anywhere",
    );
    expect(problemsWith("test", wrong)).toContainEqual(expect.stringMatching(/AUTH_SECRET/));
  });

  it("refuses the registration invitation written in this repository", () => {
    const wrong = withEnv(
      TEST_CHANNEL,
      "gateway",
      "REGISTRATION_INVITATION",
      "register-on-this-laptop",
    );
    expect(problemsWith("test", wrong)).toContainEqual(
      expect.stringMatching(/REGISTRATION_INVITATION/),
    );
  });

  it("refuses the scanner's report-link signing secret written in this repository", () => {
    // The laptop is allowed to inherit this one, so it is printed in
    // compose.yaml, which is to say printed on the internet. A channel that
    // deployed it would be signing every report link with a key any reader of
    // this repository can forge.
    const wrong = withEnv(
      TEST_CHANNEL,
      "scanner",
      "TOKEN_HMAC_SECRET",
      "a-sandbox-token-hmac-secret-nobody-should-reuse",
    );
    expect(problemsWith("test", wrong)).toContainEqual(
      expect.stringMatching(/scanner: TOKEN_HMAC_SECRET/),
    );
  });

  it("refuses a report-link signing secret the scanner would refuse to start with", () => {
    // The scanner's entrypoint stops at start-up below 32 characters, which is
    // after the migrations; refusing it here is before anything stops.
    for (const value of [null, "", "x".repeat(31)]) {
      const problems = problemsWith(
        "test",
        withEnv(TEST_CHANNEL, "scanner", "TOKEN_HMAC_SECRET", value),
      );
      expect(problems).toContainEqual(expect.stringMatching(/scanner: TOKEN_HMAC_SECRET/));
      if (value) {
        expect(problems.join("\n")).not.toContain(value);
      }
    }
    expect(
      problemsWith("test", withEnv(TEST_CHANNEL, "scanner", "TOKEN_HMAC_SECRET", "x".repeat(32))),
    ).toEqual([]);
  });

  it.each(["cabinet", "scanner"] as const)(
    "refuses the private identity credential written in this repository, on %s",
    (service) => {
      // Both halves of that route are compared, because a channel that
      // deployed the published value on either end has a private route anybody
      // can call.
      const wrong = withEnv(
        TEST_CHANNEL,
        service,
        "REPORT_IDENTITY_SECRET",
        "a-sandbox-report-identity-secret-nobody-should-reuse",
      );
      expect(problemsWith("test", wrong)).toContainEqual(
        expect.stringMatching(new RegExp(`${service}: REPORT_IDENTITY_SECRET`)),
      );
    },
  );

  it("takes an invitation set to nothing, which is a stack that takes no registrations", () => {
    const closed = withEnv(PRODUCTION_CHANNEL, "gateway", "REGISTRATION_INVITATION", "");
    expect(problemsWith("production", closed)).toEqual([]);
  });

  it("refuses a cookie that is not marked Secure", () => {
    const wrong = withEnv(TEST_CHANNEL, "cabinet", "COOKIE_SECURE", "false");
    expect(problemsWith("test", wrong)).toContainEqual(expect.stringMatching(/COOKIE_SECURE/));
  });

  it("refuses the wrong public origin, Caddy address or published port", () => {
    expect(
      problemsWith(
        "test",
        withEnv(TEST_CHANNEL, "gateway", "PUBLIC_BASE_URL", "http://localhost:8080"),
      ),
    ).toContainEqual(expect.stringMatching(/PUBLIC_BASE_URL/));

    expect(
      problemsWith("test", withEnv(TEST_CHANNEL, "web", "AGENTIFY_SITE_ADDRESS", ":8080")),
    ).toContainEqual(expect.stringMatching(/AGENTIFY_SITE_ADDRESS/));

    const wrongPort = structuredClone(TEST_CHANNEL);
    wrongPort.services.web.ports = [
      { mode: "ingress", host_ip: "10.20.10.20", target: 443, published: "443", protocol: "tcp" },
    ];
    expect(problemsWith("test", wrongPort)).toContainEqual(expect.stringMatching(/8443/));
  });

  it("refuses a published port that forwards to a container port with nothing on it", () => {
    const wrongTarget = structuredClone(TEST_CHANNEL);
    wrongTarget.services.web.ports = [
      { mode: "ingress", host_ip: "10.20.10.20", target: 8080, published: "8443", protocol: "tcp" },
    ];
    expect(problemsWith("test", wrongTarget)).toContainEqual(expect.stringMatching(/8443/));
  });

  it("refuses a door open on every interface of the host", () => {
    const everywhere = structuredClone(TEST_CHANNEL);
    everywhere.services.web.ports = [
      { mode: "ingress", target: 443, published: "8443", protocol: "tcp" },
    ];
    expect(problemsWith("test", everywhere)).toContainEqual(expect.stringMatching(/8443/));
  });

  it("refuses two otherwise correct public bindings", () => {
    // Prevents a release from publishing a second public door that the edge never owns.
    const wrong = structuredClone(TEST_CHANNEL);
    wrong.services.web.ports = [
      { mode: "ingress", host_ip: "10.20.10.20", target: 443, published: "8443", protocol: "tcp" },
      { mode: "ingress", host_ip: "10.20.10.20", target: 443, published: "8443", protocol: "tcp" },
    ];
    expect(problemsWith("test", wrong)).toContainEqual(expect.stringMatching(/8443/));
  });
});

describe("the private identity route belongs to the cabinet and the scanner alone", () => {
  // Every service of a channel shares one network and one database account,
  // so what keeps a person's identity with the cabinet is that only the
  // scanner holds the credential its private route asks for (ADR-0026).
  const CHANNELS = [
    ["test", TEST_CHANNEL],
    ["production", PRODUCTION_CHANNEL],
  ] as const;
  const secretOf = (resolved: ResolvedCompose): string => {
    const secret = envFor(resolved, "cabinet").REPORT_IDENTITY_SECRET;
    if (secret === undefined) {
      throw new Error("the fixture's cabinet holds no identity credential");
    }
    return secret;
  };

  it.each(CHANNELS)(
    "refuses the credential or the route on any other service in %s",
    (channel, config) => {
      const secret = secretOf(config);
      for (const service of ["gateway", "migrate", "web", "scanner-worker", "scanner-privacy"]) {
        const credential = problemsWith(
          channel,
          withEnv(config, service, "REPORT_IDENTITY_SECRET", secret),
        );
        expect(credential).toContainEqual(
          expect.stringMatching(`${service}: REPORT_IDENTITY_SECRET`),
        );
        expect(credential.join("\n")).not.toContain(secret);

        const route = problemsWith(
          channel,
          withEnv(config, service, "CABINET_IDENTITY_URL", "http://cabinet:3002"),
        );
        expect(route).toContainEqual(expect.stringMatching(`${service}: CABINET_IDENTITY_URL`));
      }
    },
  );

  it.each(CHANNELS)(
    "refuses two halves that hold different credentials in %s",
    (channel, config) => {
      const other = "another-report-identity-secret-of-enough-characters-1111";
      const problems = problemsWith(
        channel,
        withEnv(config, "scanner", "REPORT_IDENTITY_SECRET", other),
      );
      expect(problems).toContainEqual(expect.stringMatching(/scanner: REPORT_IDENTITY_SECRET/));
      expect(problems.join("\n")).not.toContain(other);
      expect(problems.join("\n")).not.toContain(secretOf(config));
    },
  );

  it("refuses a cabinet with no credential, or one too short to be a secret", () => {
    for (const value of [null, "", "x".repeat(31)]) {
      const withBoth = withEnv(
        withEnv(TEST_CHANNEL, "cabinet", "REPORT_IDENTITY_SECRET", value),
        "scanner",
        "REPORT_IDENTITY_SECRET",
        value,
      );
      expect(problemsWith("test", withBoth)).toContainEqual(
        expect.stringMatching(/cabinet: REPORT_IDENTITY_SECRET/),
      );
    }
  });

  it("refuses the credential reused as a secret that opens another door", () => {
    const secret = secretOf(PRODUCTION_CHANNEL);
    for (const [service, name] of [
      ["cabinet", "AUTH_SECRET"],
      ["cabinet", "REGISTRATION_INVITATION"],
      ["scanner", "TOKEN_HMAC_SECRET"],
    ] as const) {
      const problems = problemsWith(
        "production",
        withEnv(PRODUCTION_CHANNEL, service, name, secret),
      );
      expect(problems).toContainEqual(expect.stringMatching(new RegExp(`${service}: .*${name}`)));
      expect(problems.join("\n")).not.toContain(secret);
    }
  });

  it("refuses a scanner that asks anybody but the cabinet on its own network", () => {
    for (const url of [null, "https://agentify.ad/cabinet", "http://cabinet:3001"]) {
      expect(
        problemsWith(
          "production",
          withEnv(PRODUCTION_CHANNEL, "scanner", "CABINET_IDENTITY_URL", url),
        ),
      ).toContainEqual(expect.stringMatching(/scanner: CABINET_IDENTITY_URL/));
    }
  });

  it("refuses a cabinet that publishes a port on the host", () => {
    const exposed = structuredClone(PRODUCTION_CHANNEL);
    exposed.services.cabinet.ports = [
      { mode: "ingress", host_ip: "127.0.0.1", target: 3002, published: "3002", protocol: "tcp" },
    ];
    expect(problemsWith("production", exposed)).toContainEqual(
      expect.stringMatching(/cabinet: .*port/),
    );
  });
});

describe("the announcement route belongs to the gateway and the cabinet alone", () => {
  // Every service of a channel shares one network. What keeps anybody else
  // from asking the cabinet to mail a merchant about their money is that only
  // the gateway holds the secret its announcement route asks for (ADR-0019,
  // ADR-0024), that the secret opens no other door, and that the gateway asks
  // nothing but the cabinet's own listener.
  const CHANNELS = [
    ["test", TEST_CHANNEL],
    ["production", PRODUCTION_CHANNEL],
  ] as const;
  const secretOf = (resolved: ResolvedCompose): string => {
    const secret = envFor(resolved, "cabinet").ANNOUNCEMENT_SECRET;
    if (secret === undefined) {
      throw new Error("the fixture's cabinet holds no announcement secret");
    }
    return secret;
  };

  it.each(CHANNELS)(
    "refuses the secret or the route on any service but its two in %s",
    (channel, config) => {
      const secret = secretOf(config);
      for (const service of ["scanner", "web", "migrate", "scanner-worker", "scanner-privacy"]) {
        const credential = problemsWith(
          channel,
          withEnv(config, service, "ANNOUNCEMENT_SECRET", secret),
        );
        expect(credential).toContainEqual(expect.stringMatching(`${service}: ANNOUNCEMENT_SECRET`));
        expect(credential.join("\n")).not.toContain(secret);
      }
      for (const service of ["cabinet", "scanner", "web"]) {
        const route = problemsWith(
          channel,
          withEnv(config, service, "CABINET_ANNOUNCEMENT_URL", "http://cabinet:3003"),
        );
        expect(route).toContainEqual(expect.stringMatching(`${service}: CABINET_ANNOUNCEMENT_URL`));
      }
    },
  );

  it.each(CHANNELS)("refuses two halves that hold different secrets in %s", (channel, config) => {
    const other = "another-announcement-secret-of-enough-characters-2222";
    const problems = problemsWith(
      channel,
      withEnv(config, "gateway", "ANNOUNCEMENT_SECRET", other),
    );
    expect(problems).toContainEqual(expect.stringMatching(/gateway: ANNOUNCEMENT_SECRET/));
    expect(problems.join("\n")).not.toContain(other);
    expect(problems.join("\n")).not.toContain(secretOf(config));
  });

  it("refuses a cabinet with no secret, or one too short to be a secret", () => {
    for (const value of [null, "", "x".repeat(31)]) {
      const withBoth = withEnv(
        withEnv(TEST_CHANNEL, "cabinet", "ANNOUNCEMENT_SECRET", value),
        "gateway",
        "ANNOUNCEMENT_SECRET",
        value,
      );
      expect(problemsWith("test", withBoth)).toContainEqual(
        expect.stringMatching(/cabinet: ANNOUNCEMENT_SECRET/),
      );
    }
  });

  it.each(["gateway", "cabinet"] as const)(
    "refuses the secret written in this repository, on %s",
    (service) => {
      const wrong = withEnv(
        TEST_CHANNEL,
        service,
        "ANNOUNCEMENT_SECRET",
        "a-sandbox-announcement-secret-nobody-should-reuse",
      );
      expect(problemsWith("test", wrong)).toContainEqual(
        expect.stringMatching(new RegExp(`${service}: ANNOUNCEMENT_SECRET`)),
      );
    },
  );

  it("refuses the scanner's secret as the announcement secret, or the secret of any other door", () => {
    // The scanner's credential opens the route that names sessions and removes
    // people. Presented on this route as well, whoever holds either holds both.
    const secret = secretOf(PRODUCTION_CHANNEL);
    for (const [service, name] of [
      ["cabinet", "REPORT_IDENTITY_SECRET"],
      ["scanner", "REPORT_IDENTITY_SECRET"],
      ["cabinet", "AUTH_SECRET"],
      ["cabinet", "REGISTRATION_INVITATION"],
      ["gateway", "CDP_API_KEY_SECRET"],
      ["scanner", "TOKEN_HMAC_SECRET"],
    ] as const) {
      const problems = problemsWith(
        "production",
        withEnv(PRODUCTION_CHANNEL, service, name, secret),
      );
      expect(problems, `${service} ${name}`).toContainEqual(
        expect.stringMatching(new RegExp(`${service}: .*${name}`)),
      );
      expect(problems.join("\n")).not.toContain(secret);
    }
  });

  it("refuses a gateway that asks anybody but the cabinet's own listener", () => {
    for (const url of [null, "https://agentify.ad/cabinet", "http://cabinet:3002"]) {
      expect(
        problemsWith(
          "production",
          withEnv(PRODUCTION_CHANNEL, "gateway", "CABINET_ANNOUNCEMENT_URL", url),
        ),
      ).toContainEqual(expect.stringMatching(/gateway: CABINET_ANNOUNCEMENT_URL/));
    }
  });

  it("refuses a production secret still holding the template's placeholder", () => {
    const placeholder = "REPLACE_WITH_A_NEW_ANNOUNCEMENT_SECRET_OF_32_CHARACTERS";
    const both = withEnv(
      withEnv(PRODUCTION_CHANNEL, "cabinet", "ANNOUNCEMENT_SECRET", placeholder),
      "gateway",
      "ANNOUNCEMENT_SECRET",
      placeholder,
    );
    expect(problemsWith("production", both)).toContainEqual(
      expect.stringMatching(/ANNOUNCEMENT_SECRET still contains a template placeholder/),
    );
  });
});

describe("the release entry point", () => {
  it("refuses an unknown channel without starting a release", () => {
    // Prevents a typo from being treated as a valid channel with a guessed policy.
    const result = runCli("preview", JSON.stringify(TEST_CHANNEL));
    expect(result.status).toBe(65);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("preview is not a release channel");
  });

  it("refuses a cabinet public origin that diverges from the gateway", () => {
    // Deleting the cabinet origin check would send a signed-in merchant to the wrong public door.
    const wrong = withEnv(TEST_CHANNEL, "cabinet", "PUBLIC_BASE_URL", "http://localhost:8080");
    const result = runCli("test", JSON.stringify(wrong));
    const stderr = result.stderr ?? "";
    expect(result.status).toBe(65);
    expect(result.stdout ?? "").toBe("");
    expect(stderr).toContain("cabinet: PUBLIC_BASE_URL");
    expectNoFixtureSecrets(stderr, TEST_CHANNEL);
  });

  it("refuses two otherwise valid public bindings", () => {
    // Deleting the one-binding rule would publish a second public door outside the edge contract.
    const wrong = structuredClone(TEST_CHANNEL);
    wrong.services.web.ports = [
      { mode: "ingress", host_ip: "10.20.10.20", target: 443, published: "8443", protocol: "tcp" },
      { mode: "ingress", host_ip: "10.20.10.20", target: 443, published: "8443", protocol: "tcp" },
    ];
    const result = runCli("test", JSON.stringify(wrong));
    const stderr = result.stderr ?? "";
    expect(result.status).toBe(65);
    expect(result.stdout ?? "").toBe("");
    expect(stderr).toContain("web: the published bindings");
    expectNoFixtureSecrets(stderr, TEST_CHANNEL);
  });

  it("reports every test-channel live credential without printing either value", () => {
    const withId = withEnv(TEST_CHANNEL, "gateway", "CDP_API_KEY_ID", "synthetic-live-key-id");
    const wrong = withEnv(
      withEnv(withId, "gateway", "CDP_API_KEY_SECRET", "synthetic-live-key-secret"),
      "cabinet",
      "COOKIE_SECURE",
      "false",
    );
    const result = runCli("test", JSON.stringify(wrong));
    const stderr = result.stderr ?? "";
    expect(result.status).toBe(65);
    expect(result.stdout ?? "").toBe("");
    expect(stderr).toContain("CDP_API_KEY_ID");
    expect(stderr).toContain("CDP_API_KEY_SECRET");
    expect(stderr).toContain("COOKIE_SECURE");
    expectNoFixtureSecrets(stderr, wrong);
  });

  it("refuses a channel that seeds a key, before anything stops, without printing it", () => {
    // What activation meets when a host's file still gives AGENTIFY_SEED_KEY a
    // value: exit 65, which deploy/activate.sh turns into a refusal before the
    // applications stop.
    const key = `csk_test_${"x".repeat(44)}`;
    const result = runCli(
      "test",
      JSON.stringify(withEnv(TEST_CHANNEL, "gateway", "SANDBOX_MERCHANT_KEY", key)),
    );
    expect(result.status).toBe(65);
    expect(result.stdout ?? "").toBe("");
    expect(result.stderr).toContain("gateway: SANDBOX_MERCHANT_KEY");
    expect(result.stderr).not.toContain(key);
  });

  it("refuses malformed JSON without printing input", () => {
    // Prevents a parser diagnostic from copying a credential fragment into the release log.
    const sentinel = "synthetic-credential-fragment";
    const result = runCli("production", `{"credential":"${sentinel}"`);
    expect(result.status).toBe(65);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("preflight: the resolved configuration did not read as JSON\n");
    expect(result.stderr).not.toContain(sentinel);
  });
});
