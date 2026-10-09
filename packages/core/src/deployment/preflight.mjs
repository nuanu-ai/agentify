/**
 * What a release channel has to be before anything starts.
 *
 * It reads one document — `docker compose config --format json`, which
 * resolves every variable without starting a container — and answers with a
 * list of everything wrong with it. Deterministic logic over text, which is
 * why it is here and tested rather than inside the shell script that runs it.
 *
 * The last group is a list of equality checks against values anybody can read
 * in `compose.yaml`. It prints no secret and asserts nothing about strength —
 * only that the string in front of it is not the one we published to the
 * world. It stops there deliberately: whether the live site is open to
 * registrations is the operator's line in a file, and a release that tracked
 * whether the first sale had happened yet, in order to permit or forbid that
 * line, would be a state machine about our own intentions rather than a check
 * on a configuration.
 */

/** What each channel declares itself to be. */
const CHANNELS = {
  test: {
    network: "eip155:84532",
    facilitator: "https://x402.org/facilitator",
    surfaceMode: "test",
    origin: "https://test.agentify.ad",
    siteAddress: "test.agentify.ad",
    publishedPort: "8443",
    credentials: false,
  },
  production: {
    network: "eip155:8453",
    facilitator: "https://api.cdp.coinbase.com/platform/v2/x402",
    surfaceMode: "live",
    origin: "https://agentify.ad",
    siteAddress: ":8080",
    privateIngress: true,
    trustedEdgeCidr: "172.30.80.2/32",
    credentials: true,
  },
};

/**
 * The strings this repository publishes to the world. None may be deployed.
 *
 * Each names the service whose environment carries it, because the same name
 * means different things on different services and a sandbox answer on any of
 * them is a credential anybody can read. The compose files refuse most of
 * these before a render; this is what catches a deployment that supplied the
 * variable and supplied the published value.
 */
const WRITTEN_IN_THIS_REPOSITORY = [
  ["app", "AUTH_SECRET", "a-sandbox-secret-nobody-should-reuse-anywhere"],
  ["scanner", "TOKEN_HMAC_SECRET", "a-sandbox-token-hmac-secret-nobody-should-reuse"],
  ["app", "REPORT_IDENTITY_SECRET", "a-sandbox-report-identity-secret-nobody-should-reuse"],
  ["scanner", "REPORT_IDENTITY_SECRET", "a-sandbox-report-identity-secret-nobody-should-reuse"],
];

const envOf = (resolved, service) => resolved.services?.[service]?.environment ?? {};

const isPrivateIpv4 = (value) => {
  if (typeof value !== "string" || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    return false;
  }
  const parts = value.split(".").map(Number);
  if (parts.some((part) => part > 255)) {
    return false;
  }
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
};

export function problemsWith(channel, resolved) {
  const wanted = CHANNELS[channel];
  if (wanted === undefined) {
    return [`${channel} is not a release channel; the channels are test and production`];
  }

  const problems = [];
  // The gateway and the dashboard, in one process and one environment
  // (ADR-0030): a variable here means one thing to both.
  const app = envOf(resolved, "app");
  const web = envOf(resolved, "web");
  const scanner = envOf(resolved, "scanner");

  const equal = (where, name, given, expected) => {
    if (given !== expected) {
      problems.push(
        `${where}: ${name} is ${JSON.stringify(given ?? null)} and the ${channel} channel is ` +
          `${JSON.stringify(expected)}`,
      );
    }
  };

  // The chain and the facilitator together. This is the one the runtime cannot
  // make for itself: a live chain already refuses every facilitator but
  // Coinbase's, but a test chain must keep accepting sandbox:scripted, because
  // the laptop requires exactly that pairing.
  equal("app", "PAYMENT_NETWORK", app.PAYMENT_NETWORK, wanted.network);
  equal("app", "FACILITATOR_URL", app.FACILITATOR_URL, wanted.facilitator);

  if (wanted.credentials) {
    for (const name of ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET"]) {
      if ((app[name] ?? "") === "") {
        problems.push(
          `app: ${name} is not set, and the ${channel} channel settles through a facilitator ` +
            "that takes no request without credentials",
        );
      }
    }
  } else {
    for (const name of ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET"]) {
      if ((app[name] ?? "") !== "") {
        problems.push(
          `app: ${name} is set, and the ${channel} channel must not receive live ` +
            "facilitator credentials",
        );
      }
    }
  }

  equal("web", "AGENTIFY_SURFACE_MODE", web.AGENTIFY_SURFACE_MODE, wanted.surfaceMode);
  equal("web", "AGENTIFY_FRONT_PAGE", web.AGENTIFY_FRONT_PAGE, "scanner_front_page");

  // The mock merchant, which publishes two demonstration cards as it starts.
  if (resolved.services?.merchant !== undefined) {
    problems.push(
      "the mock merchant is among the services: it is the laptop's fixture, it publishes goods " +
        "nobody sells, and on a settling stack its publication is refused so the stack never " +
        "comes up. deploy/compose.public.yaml gives it a profile nothing enables",
    );
  }

  // No laptop default survived.
  if ((resolved.services?.postgres?.ports ?? []).length > 0) {
    problems.push(
      "postgres publishes a port on the host: two stacks cannot both take one, and nothing " +
        "outside the Compose network has any business reaching either database",
    );
  }

  if (channel === "production") {
    const postgres = envOf(resolved, "postgres");
    const password = postgres.POSTGRES_PASSWORD;
    if (
      postgres.POSTGRES_USER !== "agentify" ||
      postgres.POSTGRES_DB !== "agentify" ||
      typeof password !== "string" ||
      !/^[A-Za-z0-9._~-]{24,}$/.test(password) ||
      password.startsWith("REPLACE_") ||
      password === "agentify"
    ) {
      problems.push(
        "postgres: production needs a distinct URL-safe password of at least 24 characters",
      );
    } else {
      // One database for every process that has one (ADR-0003): a service
      // left naming another would start against a database nothing migrates.
      const databaseUrl = `postgres://agentify:${password}@postgres:5432/agentify`;
      for (const service of [
        "migrate",
        "app",
        "scanner-migrate",
        "scanner",
        "scanner-worker",
        "scanner-privacy",
      ]) {
        if (envOf(resolved, service).DATABASE_URL !== databaseUrl) {
          problems.push(
            `${service}: DATABASE_URL is not the one database on this private Postgres`,
          );
        }
      }
    }
    for (const name of [
      "CDP_API_KEY_ID",
      "CDP_API_KEY_SECRET",
      "AUTH_SECRET",
      "MAIL_URL",
      "MAIL_API_KEY",
      "MAIL_FROM",
    ]) {
      if ((app[name] ?? "").startsWith("REPLACE_")) {
        problems.push(`app: ${name} still contains a template placeholder`);
      }
    }
    const mailUrl = app.MAIL_URL;
    const mailFrom = app.MAIL_FROM;
    const mailApiKey = app.MAIL_API_KEY;
    if (typeof mailUrl !== "string" || mailUrl.trim() === "" || mailUrl === "sandbox:log") {
      problems.push("app: MAIL_URL needs a live provider to send confirmation and reset links");
    }
    if (typeof mailApiKey !== "string" || mailApiKey.trim() === "") {
      problems.push("app: MAIL_API_KEY is required for the live mail provider");
    }
    if (
      typeof mailFrom !== "string" ||
      mailFrom.trim() === "" ||
      /@(?:localhost|127\.0\.0\.1)(?:\b|$)/i.test(mailFrom)
    ) {
      problems.push("app: MAIL_FROM needs a non-local sender for live merchant mail");
    }
  }

  // A merchant comes into being one way: a person opens the link mailed to
  // their address and presses the one control the dashboard offers (ADR-0014,
  // ADR-0026 §4). A key the gateway seeds at start-up is a second way, kept in
  // a file and written back into the database at every start, so a deployed
  // channel seeds nothing; the laptop's stack is the one that does.
  // deploy/compose.public.yaml gives the seed nothing whatever a host's file
  // says, so a rendered one is a file after it that put a key back. The value
  // is never repeated, since it opens a merchant.
  if ((app.SANDBOX_MERCHANT_KEY ?? "") !== "") {
    problems.push(
      "app: SANDBOX_MERCHANT_KEY is set, and a deployed channel seeds no merchant: a " +
        "merchant comes into being only when a person opens the link mailed to their address " +
        "and presses the dashboard's one control. deploy/compose.public.yaml gives it nothing, so " +
        "a compose file rendered after it has put a key back",
    );
  }

  for (const [service, name, published] of WRITTEN_IN_THIS_REPOSITORY) {
    if (envOf(resolved, service)[name] === published) {
      problems.push(
        `${service}: ${name} is the value written in this repository, which anybody can read`,
      );
    }
  }

  // The scanner's private identity route (ADR-0026). Every service of a
  // channel shares one network and one database account, so what keeps a
  // person's identity with the dashboard is the credential that route asks for:
  // the scanner holds it and nothing else does, and it opens no other door.
  // The dashboard's half lives in the application, where the dashboard runs.
  const identity = app.REPORT_IDENTITY_SECRET ?? "";
  if (identity.length < 32) {
    problems.push(
      "app: REPORT_IDENTITY_SECRET is missing or shorter than 32 characters, so the " +
        "identity route has no secret to ask for",
    );
  }
  if (scanner.REPORT_IDENTITY_SECRET !== app.REPORT_IDENTITY_SECRET) {
    problems.push(
      "scanner: REPORT_IDENTITY_SECRET is not the application's, so the dashboard turns the scanner away",
    );
  }
  if (scanner.DASHBOARD_IDENTITY_URL !== "http://app:3002") {
    problems.push(
      `scanner: DASHBOARD_IDENTITY_URL is ${JSON.stringify(scanner.DASHBOARD_IDENTITY_URL ?? null)} ` +
        "and the route is http://app:3002, on this stack's own network",
    );
  }
  for (const [service, name] of [
    ["app", "AUTH_SECRET"],
    ["scanner", "TOKEN_HMAC_SECRET"],
  ]) {
    if (identity !== "" && envOf(resolved, service)[name] === identity) {
      problems.push(
        `${service}: REPORT_IDENTITY_SECRET is also its ${name}, and one credential opens one door`,
      );
    }
  }
  for (const [service, definition] of Object.entries(resolved.services ?? {})) {
    const environment = definition?.environment ?? {};
    if (service !== "app" && service !== "scanner" && "REPORT_IDENTITY_SECRET" in environment) {
      problems.push(
        `${service}: REPORT_IDENTITY_SECRET is handed to a service that is neither the application nor the scanner`,
      );
    }
    if (service !== "scanner" && "DASHBOARD_IDENTITY_URL" in environment) {
      problems.push(
        `${service}: DASHBOARD_IDENTITY_URL is handed to a service that is not the scanner`,
      );
    }
  }

  if ((resolved.services?.app?.ports ?? []).length > 0) {
    problems.push(
      "app: it publishes a port on the host, and the dashboard's identity listener answers only inside the stack",
    );
  }

  // The scanner itself refuses to start below this length, which activation
  // would meet only after the migrations.
  if ((scanner.TOKEN_HMAC_SECRET ?? "").length < 32) {
    problems.push(
      "scanner: TOKEN_HMAC_SECRET is missing or shorter than the 32 characters the scanner starts with",
    );
  }

  if (app.COOKIE_SECURE !== "true") {
    problems.push(
      `app: COOKIE_SECURE is ${JSON.stringify(app.COOKIE_SECURE ?? null)} and this stack ` +
        "is reached over https, so a session cookie without it goes to anybody on the path",
    );
  }

  equal("app", "PUBLIC_BASE_URL", app.PUBLIC_BASE_URL, wanted.origin);
  equal("web", "AGENTIFY_SITE_ADDRESS", web.AGENTIFY_SITE_ADDRESS, wanted.siteAddress);
  if (wanted.trustedEdgeCidr !== undefined) {
    equal(
      "web",
      "AGENTIFY_TRUSTED_EDGE_CIDR",
      web.AGENTIFY_TRUSTED_EDGE_CIDR,
      wanted.trustedEdgeCidr,
    );
  }

  // The public edge owns TLS for production. Its private Caddy has no host port
  // and must be discoverable by the name the edge routes to. The test channel
  // keeps its direct binding on the test host, behind the shared SNI ingress:
  // one private address, which the host's environment file names, and never
  // every interface of the machine.
  const bindings = (resolved.services?.web?.ports ?? []).map(
    (port) => `${port.host_ip ?? ""}:${port.published ?? ""}:${port.target ?? ""}`,
  );
  if (wanted.privateIngress) {
    if (bindings.length !== 0) {
      problems.push(
        `web: the published bindings are ${JSON.stringify(bindings)}; production publishes none`,
      );
    }
    const aliases = resolved.services?.web?.networks?.["agentify-ingress"]?.aliases ?? [];
    if (!aliases.includes("agentify-web")) {
      problems.push("web: agentify-ingress must expose alias agentify-web to the edge");
    }
  } else {
    const [binding, ...others] = resolved.services?.web?.ports ?? [];
    if (
      binding === undefined ||
      others.length > 0 ||
      !isPrivateIpv4(binding.host_ip) ||
      String(binding.published) !== wanted.publishedPort ||
      binding.target !== 443
    ) {
      problems.push(
        `web: the published bindings are ${JSON.stringify(bindings)} and the ${channel} channel is ` +
          `one binding from one private IPv4 address, port ${wanted.publishedPort} to 443`,
      );
    }
  }

  return problems;
}

// The command deploy/activate.sh runs inside the candidate's own app image,
// with no network. It reads the rendered configuration on stdin, so the
// secrets in it are never written to a file.
if (process.argv[1]?.endsWith("preflight.mjs")) {
  const channel = process.argv[2];
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  let resolved;
  try {
    resolved = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    console.error("preflight: the resolved configuration did not read as JSON");
    process.exit(65);
  }

  const problems = problemsWith(channel, resolved);
  if (problems.length > 0) {
    console.error(`preflight: the ${channel} channel is not what it claims to be:`);
    for (const problem of problems) {
      console.error(`  ${problem}`);
    }
    process.exit(65);
  }

  console.log(`preflight: the ${channel} channel is what it claims to be`);
}
