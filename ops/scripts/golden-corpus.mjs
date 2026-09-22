import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { pollAcceptedScans } from "./scan-evidence-lib.mjs";

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

const parseIds = (value) =>
  new Set(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );

const optionalGatewayHeaders = () => {
  const name = process.env.GOLDEN_CORPUS_GATEWAY_HEADER_NAME?.trim();
  const value = process.env.GOLDEN_CORPUS_GATEWAY_HEADER_VALUE;
  if (!name && !value) return {};
  if (!name || !value || !/^[A-Za-z0-9-]+$/.test(name))
    throw new Error("Golden-corpus gateway header name/value must be supplied together");
  if (["authorization", "content-type", "idempotency-key", "origin"].includes(name.toLowerCase()))
    throw new Error("Golden-corpus gateway header conflicts with a required scan header");
  return { [name]: value };
};

if (
  process.env.ALLOW_GOLDEN_CORPUS !== "true" ||
  process.env.GOLDEN_CORPUS_ACK_TARGET_AUTHORIZATION !== "yes"
) {
  throw new Error(
    "Refusing corpus run: set ALLOW_GOLDEN_CORPUS=true and GOLDEN_CORPUS_ACK_TARGET_AUTHORIZATION=yes",
  );
}

const environment = required("GOLDEN_CORPUS_ENVIRONMENT");
if (!["local", "staging"].includes(environment))
  throw new Error(
    "Golden corpus runs are restricted to authorized local/staging scanner environments",
  );
if (required("GOLDEN_CORPUS_RATE_LIMIT_STRATEGY") !== "authorized_staging_bypass")
  throw new Error(
    "Golden corpus requires an authorized non-production staging rate-limit strategy",
  );
const authorizationReference = required("GOLDEN_CORPUS_AUTHORIZATION_REFERENCE");
const egressRegion = required("GOLDEN_CORPUS_EGRESS_REGION");
const egressReference = required("GOLDEN_CORPUS_EGRESS_REFERENCE");
const baseUrl = new URL(required("GOLDEN_CORPUS_BASE_URL"));
if (!["http:", "https:"].includes(baseUrl.protocol))
  throw new Error("GOLDEN_CORPUS_BASE_URL must use HTTP(S)");
const manifestPath = path.resolve(
  process.env.GOLDEN_CORPUS_MANIFEST ?? "fixtures/golden-corpus/manifest.json",
);
const outputPath = path.resolve(required("GOLDEN_CORPUS_OUTPUT_FILE"));
const repositoryRoot = process.cwd();
const repositoryOutput = path.join(repositoryRoot, "output") + path.sep;
if (outputPath.startsWith(repositoryRoot + path.sep) && !outputPath.startsWith(repositoryOutput))
  throw new Error("Corpus output inside the repository must stay under ignored output/");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (!manifest || !Array.isArray(manifest.sites) || manifest.sites.length === 0)
  throw new Error("Golden corpus manifest has no sites");
const selectedIds = process.env.GOLDEN_CORPUS_TARGET_IDS
  ? parseIds(process.env.GOLDEN_CORPUS_TARGET_IDS)
  : new Set(manifest.sites.map((site) => site.id));
if (selectedIds.size === 0)
  throw new Error("GOLDEN_CORPUS_TARGET_IDS must select at least one target");
const authorizedIds = parseIds(required("GOLDEN_CORPUS_AUTHORIZED_TARGET_IDS"));
const selectedSites = manifest.sites.filter((site) => selectedIds.has(site.id));
if (selectedSites.length !== selectedIds.size)
  throw new Error("GOLDEN_CORPUS_TARGET_IDS contains an unknown manifest ID");
if (selectedSites.some((site) => !authorizedIds.has(site.id)))
  throw new Error("Every selected corpus target ID needs explicit authorization");
for (const site of selectedSites) {
  const target = new URL(site.target);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password)
    throw new Error(`Manifest target ${site.id} is not a credential-free HTTP(S) URL`);
  if (!["store", "owner", "local"].includes(site.segment))
    throw new Error(`Manifest target ${site.id} has an invalid segment`);
}

const targetConcurrency = boundedInteger("GOLDEN_CORPUS_TARGET_CONCURRENCY", 2, 1, 10);
const pollIntervalMs = boundedInteger("GOLDEN_CORPUS_POLL_INTERVAL_MS", 500, 100, 5_000);
const terminalTimeoutMs = boundedInteger(
  "GOLDEN_CORPUS_TERMINAL_TIMEOUT_MS",
  75_000,
  5_000,
  180_000,
);
const gatewayHeaders = optionalGatewayHeaders();
const startedAt = new Date();

const submitAndPoll = async (site, runNumber) => {
  const requestStartedAt = performance.now();
  let response;
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
        url: site.target,
        segment: site.segment,
        landing_variant: "authorized-golden-corpus",
        turnstile_token: null,
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return {
      run: runNumber,
      outcome: "network_error",
      apiDurationMs: Number((performance.now() - requestStartedAt).toFixed(1)),
    };
  }
  const body = await response.json().catch(() => ({}));
  const acceptedAtMs = performance.now();
  if (
    response.status !== 202 ||
    typeof body.scan_id !== "string" ||
    typeof body.access_token !== "string" ||
    typeof body.status_url !== "string"
  ) {
    return {
      run: runNumber,
      outcome: "not_accepted",
      apiStatus: response.status,
      apiDurationMs: Number((acceptedAtMs - requestStartedAt).toFixed(1)),
    };
  }
  const statusUrl = new URL(body.status_url, baseUrl);
  if (
    statusUrl.origin !== baseUrl.origin ||
    statusUrl.pathname !== `/api/v1/scans/${encodeURIComponent(body.scan_id)}/status`
  ) {
    return { run: runNumber, outcome: "invalid_capability" };
  }

  const polled = await pollAcceptedScans(
    [
      {
        scanId: body.scan_id,
        accessToken: body.access_token,
        statusUrl: body.status_url,
        acceptedAtMs,
      },
    ],
    {
      intervalMs: pollIntervalMs,
      timeoutMs: terminalTimeoutMs,
      fetchStatus: async (scan) => {
        const statusResponse = await fetch(new URL(scan.statusUrl, baseUrl), {
          headers: {
            authorization: `Bearer ${scan.accessToken}`,
            ...gatewayHeaders,
          },
          signal: AbortSignal.timeout(5_000),
        });
        if (!statusResponse.ok) throw new Error(`status_${statusResponse.status}`);
        return await statusResponse.json();
      },
    },
  );
  const result = polled.results[0];
  if (result.outcome !== "terminal")
    return {
      run: runNumber,
      outcome: result.outcome,
      lastStatus: result.lastStatus,
    };
  if (!Array.isArray(result.payload.checks))
    return { run: runNumber, outcome: "invalid_status_payload" };

  const verdicts = [...result.payload.checks]
    .map((check) => [Number(check.id), String(check.status)])
    .sort((left, right) => left[0] - right[0]);
  if (
    verdicts.length !== 18 ||
    new Set(verdicts.map(([checkId]) => checkId)).size !== 18 ||
    verdicts.some(
      ([checkId, status]) =>
        !Number.isInteger(checkId) ||
        checkId < 1 ||
        checkId > 18 ||
        !["pass", "partial", "fail", "unavailable", "not_applicable"].includes(status),
    )
  )
    return { run: runNumber, outcome: "invalid_status_payload" };
  const verdictDigest = createHash("sha256").update(JSON.stringify(verdicts)).digest("hex");
  return {
    run: runNumber,
    outcome: "terminal",
    terminalStatus: result.terminalStatus,
    apiDurationMs: Number((acceptedAtMs - requestStartedAt).toFixed(1)),
    queueDurationMs: Number(result.queueMs.toFixed(1)),
    terminalDurationMs: Number(result.terminalMs.toFixed(1)),
    coverage: result.payload.teaser?.coverage ?? null,
    verdictDigest,
    verdicts,
  };
};

const runTarget = async (site) => {
  const runs = [];
  for (let runNumber = 1; runNumber <= 2; runNumber += 1)
    runs.push(await submitAndPoll(site, runNumber));
  const terminalRuns = runs.filter((run) => run.outcome === "terminal");
  let agreement = 0;
  let mismatchedCheckIds = [];
  if (terminalRuns.length === 2) {
    const second = new Map(terminalRuns[1].verdicts);
    const matched = terminalRuns[0].verdicts.filter(
      ([checkId, status]) => second.get(checkId) === status,
    ).length;
    const total = Math.max(terminalRuns[0].verdicts.length, second.size, 18);
    agreement = matched / total;
    mismatchedCheckIds = terminalRuns[0].verdicts
      .filter(([checkId, status]) => second.get(checkId) !== status)
      .map(([checkId]) => checkId);
  }
  return {
    id: site.id,
    segment: site.segment,
    agreement: Number(agreement.toFixed(4)),
    minimumCoverage:
      terminalRuns.length === 2 ? Math.min(...terminalRuns.map((run) => run.coverage ?? 0)) : null,
    mismatchedCheckIds,
    runs: runs.map(({ verdicts: _verdicts, ...run }) => run),
  };
};

const targetResults = new Array(selectedSites.length);
let nextTargetIndex = 0;
await Promise.all(
  Array.from({ length: Math.min(targetConcurrency, selectedSites.length) }, async () => {
    while (nextTargetIndex < selectedSites.length) {
      const index = nextTargetIndex;
      nextTargetIndex += 1;
      targetResults[index] = await runTarget(selectedSites[index]);
    }
  }),
);

const allRuns = targetResults.flatMap((target) => target.runs);
const terminalRuns = allRuns.filter((run) => run.outcome === "terminal");
const aggregateAgreement =
  targetResults.reduce((sum, target) => sum + target.agreement, 0) / targetResults.length;
const coverageQualifiedTargets = targetResults.filter(
  (target) => (target.minimumCoverage ?? 0) >= 0.7,
).length;
const evidence = {
  schemaVersion: "golden-corpus-evidence-v1",
  runId: randomUUID(),
  manifestVersion: manifest.version,
  rubricVersion: manifest.rubric_version,
  environment,
  authorizationReference,
  egressRegion,
  egressReference,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  selectedTargets: selectedSites.length,
  expectedRuns: selectedSites.length * 2,
  terminalRuns: terminalRuns.length,
  deterministicAgreement: Number(aggregateAgreement.toFixed(4)),
  coverageQualifiedTargets,
  coverageQualifiedFraction: Number((coverageQualifiedTargets / selectedSites.length).toFixed(4)),
  allRunsUnder60Seconds: terminalRuns.every((run) => run.terminalDurationMs < 60_000),
  targets: targetResults,
};

await mkdir(path.dirname(outputPath), { recursive: true });
const temporaryOutput = `${outputPath}.${process.pid}.tmp`;
await writeFile(temporaryOutput, `${JSON.stringify(evidence, null, 2)}\n`, {
  mode: 0o600,
});
await rename(temporaryOutput, outputPath);
await chmod(outputPath, 0o600);
process.stdout.write(
  `${JSON.stringify({ runId: evidence.runId, selectedTargets: evidence.selectedTargets, terminalRuns: evidence.terminalRuns, deterministicAgreement: evidence.deterministicAgreement, coverageQualifiedFraction: evidence.coverageQualifiedFraction, allRunsUnder60Seconds: evidence.allRunsUnder60Seconds, outputFile: path.relative(repositoryRoot, outputPath) })}\n`,
);

const failures = [];
if (terminalRuns.length !== evidence.expectedRuns)
  failures.push(`${evidence.expectedRuns - terminalRuns.length} corpus runs were not terminal`);
if (terminalRuns.some((run) => run.terminalStatus === "failed"))
  failures.push("one or more corpus runs ended failed");
if (!evidence.allRunsUnder60Seconds) failures.push("one or more corpus runs exceeded 60 seconds");
if (evidence.deterministicAgreement < 0.95)
  failures.push(`deterministic agreement ${evidence.deterministicAgreement} is below 0.95`);
if (evidence.coverageQualifiedFraction < 0.9)
  failures.push(
    `coverage-qualified target fraction ${evidence.coverageQualifiedFraction} is below 0.9`,
  );
if (failures.length) throw new Error(failures.join("; "));
