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
  ["gateway", "SANDBOX_MERCHANT_KEY", "csk_test_local-sandbox-merchant-key"],
  ["cabinet", "AUTH_SECRET", "a-sandbox-secret-nobody-should-reuse-anywhere"],
  ["gateway", "REGISTRATION_INVITATION", "register-on-this-laptop"],
  ["scanner", "TOKEN_HMAC_SECRET", "a-sandbox-token-hmac-secret-nobody-should-reuse"],
  ["cabinet", "REPORT_IDENTITY_SECRET", "a-sandbox-report-identity-secret-nobody-should-reuse"],
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
  const gateway = envOf(resolved, "gateway");
  const cabinet = envOf(resolved, "cabinet");
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
  equal("gateway", "PAYMENT_NETWORK", gateway.PAYMENT_NETWORK, wanted.network);
  equal("gateway", "FACILITATOR_URL", gateway.FACILITATOR_URL, wanted.facilitator);

  if (wanted.credentials) {
    for (const name of ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET"]) {
      if ((gateway[name] ?? "") === "") {
        problems.push(
          `gateway: ${name} is not set, and the ${channel} channel settles through a facilitator ` +
            "that takes no request without credentials",
        );
      }
    }
  } else {
    for (const name of ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET"]) {
      if ((gateway[name] ?? "") !== "") {
        problems.push(
          `gateway: ${name} is set, and the ${channel} channel must not receive live ` +
            "facilitator credentials",
        );
      }
    }
  }

  equal("web", "AGENTIFY_SURFACE_MODE", web.AGENTIFY_SURFACE_MODE, wanted.surfaceMode);
  equal("web", "AGENTIFY_FRONT_PAGE", web.AGENTIFY_FRONT_PAGE, "scanner_front_page");

  // The cabinet was handed the gateway's pair, compared value for value. A
  // cabinet on the scripted facilitator beside a gateway on the public one
  // renders a page saying nothing settles here, which is false about a stack
  // that settles on Sepolia — and a probe that asked only whether a banner was
  // present would find one and pass.
  if (cabinet.PAYMENT_NETWORK !== gateway.PAYMENT_NETWORK) {
    problems.push(
      `cabinet: PAYMENT_NETWORK is ${JSON.stringify(cabinet.PAYMENT_NETWORK ?? null)} and its ` +
        `gateway's is ${JSON.stringify(gateway.PAYMENT_NETWORK ?? null)}`,
    );
  }
  if (cabinet.FACILITATOR_URL !== gateway.FACILITATOR_URL) {
    problems.push(
      `cabinet: FACILITATOR_URL is ${JSON.stringify(cabinet.FACILITATOR_URL ?? null)} and its ` +
        `gateway's is ${JSON.stringify(gateway.FACILITATOR_URL ?? null)}`,
    );
  }

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
      postgres.POSTGRES_USER !== "agentify_commerce" ||
      postgres.POSTGRES_DB !== "agentify_commerce" ||
      typeof password !== "string" ||
      !/^[A-Za-z0-9._~-]{24,}$/.test(password) ||
      password.startsWith("REPLACE_") ||
      password === "agentify_commerce"
    ) {
      problems.push(
        "postgres: production needs a distinct URL-safe password of at least 24 characters",
      );
    } else {
      const databaseUrl = `postgres://agentify_commerce:${password}@postgres:5432/agentify_commerce`;
      for (const service of ["migrate", "gateway", "cabinet"]) {
        if (envOf(resolved, service).DATABASE_URL !== databaseUrl) {
          problems.push(`${service}: DATABASE_URL is not wired to this private commerce Postgres`);
        }
      }
    }
    for (const [service, names] of [
      [
        "gateway",
        ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "SANDBOX_MERCHANT_KEY", "REGISTRATION_INVITATION"],
      ],
      ["cabinet", ["AUTH_SECRET", "MAIL_URL", "MAIL_API_KEY", "MAIL_FROM"]],
    ]) {
      for (const name of names) {
        if ((envOf(resolved, service)[name] ?? "").startsWith("REPLACE_")) {
          problems.push(`${service}: ${name} still contains a template placeholder`);
        }
      }
    }
    const mailUrl = cabinet.MAIL_URL;
    const mailFrom = cabinet.MAIL_FROM;
    const mailApiKey = cabinet.MAIL_API_KEY;
    if (typeof mailUrl !== "string" || mailUrl.trim() === "" || mailUrl === "sandbox:log") {
      problems.push("cabinet: MAIL_URL needs a live provider to send confirmation and reset links");
    }
    if (typeof mailApiKey !== "string" || mailApiKey.trim() === "") {
      problems.push("cabinet: MAIL_API_KEY is required for the live mail provider");
    }
    if (
      typeof mailFrom !== "string" ||
      mailFrom.trim() === "" ||
      /@(?:localhost|127\.0\.0\.1)(?:\b|$)/i.test(mailFrom)
    ) {
      problems.push("cabinet: MAIL_FROM needs a non-local sender for live merchant mail");
    }
  }

  if ((gateway.SANDBOX_MERCHANT_KEY ?? "") === "") {
    problems.push(
      "gateway: SANDBOX_MERCHANT_KEY is not set, so this stack seeds no merchant and there is " +
        "nobody to sign in as",
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
  // person's identity with the cabinet is the credential that route asks for:
  // the scanner holds it and nothing else does, and it opens no other door.
  const identity = cabinet.REPORT_IDENTITY_SECRET ?? "";
  if (identity.length < 32) {
    problems.push(
      "cabinet: REPORT_IDENTITY_SECRET is missing or shorter than 32 characters, so the " +
        "identity route has no secret to ask for",
    );
  }
  if (scanner.REPORT_IDENTITY_SECRET !== cabinet.REPORT_IDENTITY_SECRET) {
    problems.push(
      "scanner: REPORT_IDENTITY_SECRET is not the cabinet's, so the cabinet turns the scanner away",
    );
  }
  if (scanner.CABINET_IDENTITY_URL !== "http://cabinet:3002") {
    problems.push(
      `scanner: CABINET_IDENTITY_URL is ${JSON.stringify(scanner.CABINET_IDENTITY_URL ?? null)} ` +
        "and the route is http://cabinet:3002, on this stack's own network",
    );
  }
  for (const [service, name] of [
    ["cabinet", "AUTH_SECRET"],
    ["cabinet", "REGISTRATION_INVITATION"],
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
    if (service !== "cabinet" && service !== "scanner" && "REPORT_IDENTITY_SECRET" in environment) {
      problems.push(
        `${service}: REPORT_IDENTITY_SECRET is handed to a service that is neither the cabinet nor the scanner`,
      );
    }
    if (service !== "scanner" && "CABINET_IDENTITY_URL" in environment) {
      problems.push(
        `${service}: CABINET_IDENTITY_URL is handed to a service that is not the scanner`,
      );
    }
  }
  if ((resolved.services?.cabinet?.ports ?? []).length > 0) {
    problems.push(
      "cabinet: it publishes a port on the host, and its identity listener answers only inside the stack",
    );
  }

  // The scanner itself refuses to start below this length, which activation
  // would meet only after the migrations.
  if ((scanner.TOKEN_HMAC_SECRET ?? "").length < 32) {
    problems.push(
      "scanner: TOKEN_HMAC_SECRET is missing or shorter than the 32 characters the scanner starts with",
    );
  }

  if (cabinet.COOKIE_SECURE !== "true") {
    problems.push(
      `cabinet: COOKIE_SECURE is ${JSON.stringify(cabinet.COOKIE_SECURE ?? null)} and this stack ` +
        "is reached over https, so a session cookie without it goes to anybody on the path",
    );
  }

  equal("gateway", "PUBLIC_BASE_URL", gateway.PUBLIC_BASE_URL, wanted.origin);
  equal("cabinet", "PUBLIC_BASE_URL", cabinet.PUBLIC_BASE_URL, wanted.origin);
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
