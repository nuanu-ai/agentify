import { randomUUID } from "node:crypto";

import {
  analyzeAcceptedResponses,
  percentile,
  pollAcceptedScans,
  statusCounts,
} from "./scan-evidence-lib.mjs";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const boundedInteger = (name, fallback, minimum, maximum) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
};

const parseTargetUrls = () => {
  let values;
  try {
    values = JSON.parse(required("OWNED_LOAD_TARGET_URLS"));
  } catch {
    throw new Error("OWNED_LOAD_TARGET_URLS must be a JSON array");
  }
  if (!Array.isArray(values) || values.length === 0)
    throw new Error("OWNED_LOAD_TARGET_URLS must contain at least one URL");
  return values.map((value) => {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error(
        "Every owned load target must be a credential-free HTTP(S) URL",
      );
    return url;
  });
};

const optionalGatewayHeaders = () => {
  const name = process.env.LOAD_TEST_GATEWAY_HEADER_NAME?.trim();
  const value = process.env.LOAD_TEST_GATEWAY_HEADER_VALUE;
  if (!name && !value) return {};
  if (!name || !value || !/^[A-Za-z0-9-]+$/.test(name))
    throw new Error("Gateway header name/value must be supplied together");
  if (
    ["authorization", "content-type", "idempotency-key", "origin"].includes(
      name.toLowerCase(),
    )
  )
    throw new Error("Gateway header conflicts with a required scan header");
  return { [name]: value };
};

const optionalWorkerHeaders = () => {
  const name = process.env.LOAD_TEST_WORKER_HEADER_NAME?.trim();
  const value = process.env.LOAD_TEST_WORKER_HEADER_VALUE;
  if (!name && !value) return {};
  if (!name || !value || !/^[A-Za-z0-9-]+$/.test(name))
    throw new Error("Worker header name/value must be supplied together");
  return { [name]: value };
};

if (
  process.env.ALLOW_LOAD_TEST !== "true" ||
  process.env.LOAD_TEST_ACK_OWNED_TARGET !== "yes"
) {
  throw new Error(
    "Refusing load test: set ALLOW_LOAD_TEST=true and LOAD_TEST_ACK_OWNED_TARGET=yes",
  );
}

const environment = required("LOAD_TEST_ENVIRONMENT");
if (!["local", "staging", "production"].includes(environment))
  throw new Error(
    "LOAD_TEST_ENVIRONMENT must be local, staging, or production",
  );
const baseUrl = new URL(required("LOAD_TEST_BASE_URL"));
const workerBaseUrl = new URL(required("LOAD_TEST_WORKER_BASE_URL"));
if (
  ![baseUrl, workerBaseUrl].every((url) =>
    ["http:", "https:"].includes(url.protocol),
  )
)
  throw new Error("Load-test web and worker URLs must use HTTP(S)");
if (
  environment === "production" &&
  process.env.ALLOW_PRODUCTION_LOAD_TEST !== "true"
)
  throw new Error(
    "Refusing production load test without ALLOW_PRODUCTION_LOAD_TEST=true",
  );

const strategy = required("LOAD_TEST_RATE_LIMIT_STRATEGY");
if (!["authorized_staging_bypass", "owned_targets"].includes(strategy))
  throw new Error(
    "LOAD_TEST_RATE_LIMIT_STRATEGY must be authorized_staging_bypass or owned_targets",
  );
if (strategy === "authorized_staging_bypass") {
  if (environment === "production")
    throw new Error(
      "A staging rate-limit bypass must never be sent to production",
    );
  required("LOAD_TEST_AUTHORIZATION_REFERENCE");
}

const requests = boundedInteger("LOAD_TEST_REQUESTS", 50, 1, 50);
const targets = parseTargetUrls();
if (strategy === "owned_targets") {
  if (targets.length < 2)
    throw new Error(
      "owned_targets strategy requires multiple explicitly owned targets",
    );
  if (requests > 10)
    throw new Error(
      "A single-egress owned-target run cannot exceed the application hard cap of 10 scans/IP/hour; use an authorized non-production staging bypass for the 50-scan gate",
    );
  const perHost = new Map();
  for (let index = 0; index < requests; index += 1) {
    const hostname = targets[index % targets.length].hostname;
    perHost.set(hostname, (perHost.get(hostname) ?? 0) + 1);
  }
  if ([...perHost.values()].some((count) => count > 10))
    throw new Error("Owned-target distribution exceeds 10 scans/target/day");
}

const segment = process.env.LOAD_TEST_SEGMENT ?? "owner";
if (!["store", "owner", "local"].includes(segment))
  throw new Error("Invalid LOAD_TEST_SEGMENT");
const expectedMaxConcurrency = boundedInteger(
  "LOAD_TEST_EXPECTED_MAX_CONCURRENCY",
  10,
  1,
  10,
);
const pollIntervalMs = boundedInteger(
  "LOAD_TEST_POLL_INTERVAL_MS",
  500,
  100,
  5_000,
);
const terminalTimeoutMs = boundedInteger(
  "LOAD_TEST_TERMINAL_TIMEOUT_MS",
  75_000,
  5_000,
  180_000,
);
const gatewayHeaders = optionalGatewayHeaders();
const workerHeaders = optionalWorkerHeaders();
const workerReadiness = await fetch(new URL("/health/ready", workerBaseUrl), {
  headers: workerHeaders,
  signal: AbortSignal.timeout(5_000),
});
const workerHealth = await workerReadiness.json().catch(() => ({}));
const workerConfiguredConcurrency =
  workerHealth?.checks?.configured_concurrency;
if (
  !workerReadiness.ok ||
  !Number.isInteger(workerConfiguredConcurrency) ||
  workerConfiguredConcurrency < 1
)
  throw new Error(
    "Worker readiness must expose a positive integer checks.configured_concurrency",
  );
const startedAt = performance.now();

const submissions = await Promise.all(
  Array.from({ length: requests }, async (_, index) => {
    const requestStartedAt = performance.now();
    let response;
    let body = {};
    try {
      response = await fetch(new URL("/api/v1/scans", baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
          origin: baseUrl.origin,
          ...gatewayHeaders,
        },
        body: JSON.stringify({
          url: targets[index % targets.length].toString(),
          segment,
          landing_variant: "authorized-load-test",
          turnstile_token: null,
        }),
        signal: AbortSignal.timeout(5_000),
      });
      body = await response.json().catch(() => ({}));
    } catch {
      return {
        status: "network_error",
        apiMs: performance.now() - requestStartedAt,
      };
    }
    const acceptedAtMs = performance.now();
    return {
      status: response.status,
      apiMs: acceptedAtMs - requestStartedAt,
      acceptedAtMs,
      scanId: body.scan_id,
      accessToken: body.access_token,
      statusUrl: body.status_url,
    };
  }),
);

const acceptance = analyzeAcceptedResponses(submissions);
const accepted = acceptance.accepted.filter((scan) => {
  try {
    const statusUrl = new URL(scan.statusUrl, baseUrl);
    return (
      statusUrl.origin === baseUrl.origin &&
      statusUrl.pathname ===
        `/api/v1/scans/${encodeURIComponent(scan.scanId)}/status`
    );
  } catch {
    return false;
  }
});
const invalidStatusUrls = acceptance.accepted.length - accepted.length;

const polled = await pollAcceptedScans(accepted, {
  intervalMs: pollIntervalMs,
  timeoutMs: terminalTimeoutMs,
  fetchStatus: async (scan) => {
    const response = await fetch(new URL(scan.statusUrl, baseUrl), {
      headers: {
        authorization: `Bearer ${scan.accessToken}`,
        ...gatewayHeaders,
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`status_${response.status}`);
    return await response.json();
  },
});

const terminal = polled.results.filter(
  (result) => result.outcome === "terminal",
);
const lost = polled.results.filter((result) => result.outcome !== "terminal");
const lostIds = lost.length + invalidStatusUrls + acceptance.malformedAccepted;
const failedTerminal = terminal.filter(
  (result) => result.terminalStatus === "failed",
);
const queueP95Ms = percentile(
  terminal.map((result) => result.queueMs),
  0.95,
);
const terminalP95Ms = percentile(
  terminal.map((result) => result.terminalMs),
  0.95,
);
const summary = {
  runId: randomUUID(),
  environment,
  strategy,
  requests,
  accepted: acceptance.acceptedResponses,
  validCapabilities: accepted.length,
  terminal: terminal.length,
  failedTerminal: failedTerminal.length,
  lostIds,
  unpollableAccepted: invalidStatusUrls,
  malformedAccepted: acceptance.malformedAccepted,
  invalidStatusUrls,
  duplicateIds: acceptance.duplicateIds,
  httpStatusCounts: statusCounts(submissions),
  acceptedApiP95Ms: Number(acceptance.apiP95Ms.toFixed(1)),
  firstRunningOrTerminalQueueP95Ms: Number(queueP95Ms.toFixed(1)),
  terminalScanP95Ms: Number(terminalP95Ms.toFixed(1)),
  workerConfiguredConcurrency,
  observedMaxRunning: polled.observedMaxRunning,
  wallMs: Number((performance.now() - startedAt).toFixed(1)),
};
process.stdout.write(`${JSON.stringify(summary)}\n`);

const failures = [];
if (acceptance.acceptedResponses !== requests)
  failures.push(
    `${requests - acceptance.acceptedResponses} requests were not accepted`,
  );
if (acceptance.malformedAccepted || invalidStatusUrls)
  failures.push("accepted responses contained invalid capabilities");
if (acceptance.duplicateIds) failures.push("duplicate scan IDs returned");
if (lostIds)
  failures.push(`${lostIds} accepted scan IDs did not reach terminal state`);
if (failedTerminal.length)
  failures.push(`${failedTerminal.length} scans ended failed`);
if (acceptance.apiP95Ms >= 500)
  failures.push(
    `accepted API p95 ${acceptance.apiP95Ms.toFixed(1)}ms exceeds 500ms`,
  );
if (queueP95Ms >= 5_000)
  failures.push(`queue p95 ${queueP95Ms.toFixed(1)}ms exceeds 5000ms`);
if (terminalP95Ms >= 60_000)
  failures.push(
    `terminal scan p95 ${terminalP95Ms.toFixed(1)}ms exceeds 60000ms`,
  );
if (workerConfiguredConcurrency > expectedMaxConcurrency)
  failures.push(
    `worker configured concurrency ${workerConfiguredConcurrency} exceeds ${expectedMaxConcurrency}`,
  );
if (polled.observedMaxRunning > expectedMaxConcurrency)
  failures.push(
    `observed running concurrency ${polled.observedMaxRunning} exceeds ${expectedMaxConcurrency}`,
  );
if (failures.length) throw new Error(failures.join("; "));
