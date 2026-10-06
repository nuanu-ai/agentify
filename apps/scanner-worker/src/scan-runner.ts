import {
  canonicalizeTarget,
  evaluateChecks,
  evaluateScan,
  type FetchArtifact,
  isPathAllowed,
  parseRobots,
  parseSafeJson,
  parseSitemap,
  type RobotsParseResult,
  type ScanArtifacts,
  type ScanEvaluation,
} from "@agentify/scanner";
import type { CheckResult, ScanJobV1 } from "@agentify/scanner-contracts";
import { getDomain } from "tldts";
import {
  type DnsResolver,
  type PinnedTransport,
  RequestBudget,
  SafeFetcher,
} from "./safe-fetch.js";

export type ScanMetric =
  | { name: "scan_duration_ms"; value: number }
  | { name: "scan_requests"; value: number }
  | { name: "scan_coverage"; value: number }
  | { name: "fetch_error"; value: 1; code: string };

export type ScanRunnerDependencies = {
  resolver: DnsResolver;
  transport: PinnedTransport;
  appBaseUrl: string;
  emitMetric?: (metric: ScanMetric) => void;
  now?: () => number;
};

export type ScanRunOptions = {
  onChecksComplete?: (checks: CheckResult[]) => Promise<void>;
};

const robotsUrl = (target: URL): URL => new URL("/robots.txt", target.origin);
const discoveryUrl = (target: URL, path: string): URL => new URL(path, target.origin);

const registrableDomain = (url: URL): string | null =>
  getDomain(url.hostname, { allowPrivateDomains: true });

export const isSameSite = (left: URL, right: URL): boolean => {
  if (left.hostname === right.hostname) return true;
  const leftDomain = registrableDomain(left);
  return leftDomain !== null && leftDomain === registrableDomain(right);
};

const canonicalSameSiteUrl = (
  value: string,
  target: URL,
  useFallbackOrigin: boolean,
): URL | undefined => {
  try {
    const candidate = canonicalizeTarget(value);
    if (!isSameSite(candidate, target)) return undefined;
    if (useFallbackOrigin && candidate.hostname === target.hostname) {
      candidate.protocol = target.protocol;
      candidate.port = target.port;
    }
    return candidate;
  } catch {
    return undefined;
  }
};

const authDeclared = (artifacts: Pick<ScanArtifacts, "mcp" | "ucp">): boolean =>
  [...artifacts.mcp, ...(artifacts.ucp ? [artifacts.ucp] : [])].some((artifact) => {
    const parsed = parseSafeJson(artifact.body);
    return parsed !== undefined && /oauth|bearer|authorization/i.test(JSON.stringify(parsed));
  });

const unavailableArtifact = (url: URL, errorCode: string): FetchArtifact => ({
  url: url.toString(),
  status: 0,
  headers: {},
  body: "",
  decodedBytes: 0,
  truncated: false,
  durationMs: 0,
  ttfbMs: 0,
  errorCode,
});

const skeletonArtifacts = (job: ScanJobV1, target: URL, robots: FetchArtifact): ScanArtifacts => ({
  segment: job.segment,
  canonicalTargetUrl: target.toString(),
  robots,
  agentProbes: {},
  sitemap: [],
  mcp: [],
  oauth: [],
});

const productCandidates = (
  target: URL,
  sitemapArtifacts: readonly FetchArtifact[],
  useFallbackOrigin: boolean,
): URL[] => {
  const seen = new Set<string>();
  const candidates: URL[] = [];
  for (const value of sitemapArtifacts.flatMap((artifact) => {
    const parsed = parseSitemap(artifact.body);
    return parsed.valid && !parsed.isIndex ? parsed.urls : [];
  })) {
    const candidate = canonicalSameSiteUrl(value, target, useFallbackOrigin);
    if (
      !candidate ||
      !/(?:^|\/)(?:products?|shop|items?|sku)(?:\/|$)|\/p\//i.test(candidate.pathname) ||
      seen.has(candidate.toString())
    )
      continue;
    seen.add(candidate.toString());
    candidates.push(candidate);
    if (candidates.length === 2) break;
  }
  return candidates;
};

export class ScanRunner {
  constructor(private readonly dependencies: ScanRunnerDependencies) {}

  async run(
    job: ScanJobV1,
    options: ScanRunOptions = {},
  ): Promise<ScanEvaluation & { requestCount: number }> {
    const startedAt = (this.dependencies.now ?? Date.now)();
    const rawTarget = job.canonical_target_url;
    const schemeWasMissing = job.submitted_without_scheme === true;
    const target = canonicalizeTarget(rawTarget);
    const deadline = Math.min(Date.parse(job.deadline_at), startedAt + 55_000);
    if (!Number.isFinite(deadline) || deadline <= startedAt)
      throw new Error("scan_deadline_expired");
    const controller = new AbortController();
    const deadlineTimer = setTimeout(
      () => controller.abort("global_deadline"),
      deadline - startedAt,
    );
    const budget = new RequestBudget(18, 2);
    const scannerPage = `${this.dependencies.appBaseUrl.replace(/\/$/, "")}/scanner`;
    // Check 13 carries an AI agent's token, which is what a CDN's AI-bot rule
    // matches, and names the scanner after it: it never passes for the agent.
    const asAgent = (token: string) =>
      `${token} (compatible; agentify-scanner/1.0; +${scannerPage})`;
    const fetcher = new SafeFetcher(
      this.dependencies.resolver,
      this.dependencies.transport,
      budget,
      `agentify-scanner/1.0 (+${scannerPage})`,
    );
    const fetch = async (
      input: string | URL,
      fetchOptions: Parameters<SafeFetcher["fetch"]>[1] = {},
    ) => {
      const canonical = canonicalizeTarget(input.toString());
      if (controller.signal.aborted) return unavailableArtifact(canonical, "global_deadline");
      const artifact = await fetcher
        .fetch(input, { ...fetchOptions, signal: controller.signal })
        .catch((error: unknown) => {
          if (
            error instanceof Error &&
            (error.name === "AbortError" || error.message === "request_budget_exhausted")
          )
            return unavailableArtifact(
              canonical,
              error.name === "AbortError" ? "global_deadline" : "request_budget_exhausted",
            );
          throw error;
        });
      if (artifact.errorCode)
        this.dependencies.emitMetric?.({
          name: "fetch_error",
          value: 1,
          code: artifact.errorCode,
        });
      return artifact;
    };
    const emitted = new Set<number>();
    const emitChecks = async (artifacts: ScanArtifacts, checkIds: readonly number[]) => {
      if (!options.onChecksComplete) return;
      const results = evaluateChecks(artifacts).filter(
        (check) => checkIds.includes(check.id) && !emitted.has(check.id),
      );
      if (!results.length) return;
      await options.onChecksComplete(results);
      for (const check of results) emitted.add(check.id);
    };

    try {
      const robotsInput = schemeWasMissing ? `${target.host}/robots.txt` : robotsUrl(target);
      const robots = await fetch(robotsInput, {
        bodyLimit: 512 * 1024,
        accept: "text/plain,*/*;q=0.1",
      });
      const usedHttpFallback = schemeWasMissing && new URL(robots.url).protocol === "http:";
      if (usedHttpFallback) target.protocol = "http:";
      const initialArtifacts = skeletonArtifacts(job, target, robots);
      await emitChecks(initialArtifacts, [1, 2, 3]);

      const parsedRobots = parseRobots(robots.body);
      const robotsDecisionKnown =
        !robots.errorCode &&
        ([404, 410].includes(robots.status) || (robots.status === 200 && !parsedRobots.fatal));
      // Each host of the site answers for itself: its robots.txt is read the
      // first time a request, or a redirect, would reach it.
      type RobotsReading = { artifact: FetchArtifact; parsed: RobotsParseResult };
      const robotsByOrigin = new Map<string, Promise<RobotsReading>>([
        [target.origin, Promise.resolve({ artifact: robots, parsed: parsedRobots })],
      ]);
      const readRobotsOf = (origin: string): Promise<RobotsReading> => {
        let reading = robotsByOrigin.get(origin);
        if (!reading) {
          reading = fetch(new URL("/robots.txt", origin), {
            bodyLimit: 512 * 1024,
            accept: "text/plain,*/*;q=0.1",
          }).then((artifact) => ({ artifact, parsed: parseRobots(artifact.body) }));
          robotsByOrigin.set(origin, reading);
        }
        return reading;
      };
      // true or false for the URL, its query included, or undefined when its
      // host's robots.txt could not be read or the decision would cost more
      // than the matcher's budget.
      const verdictOf = ({ artifact, parsed }: RobotsReading, url: URL) => {
        if (artifact.status === 404 || artifact.status === 410) return true;
        if (artifact.errorCode || artifact.status !== 200 || parsed.fatal) return undefined;
        return isPathAllowed(parsed, "agentify-scanner", `${url.pathname || "/"}${url.search}`);
      };
      const robotsVerdict = async (url: URL): Promise<boolean | undefined> =>
        verdictOf(await readRobotsOf(url.origin), url);
      // Why a URL is not read, or undefined when robots.txt lets it be. A
      // robots.txt the network kept from being read names that failure: the
      // host is what could not be reached, not its rules.
      const admit = async (url: URL): Promise<string | undefined> => {
        const reading = await readRobotsOf(url.origin);
        const verdict = verdictOf(reading, url);
        if (verdict === true) return undefined;
        if (verdict === false) return "robots_disallowed";
        return reading.artifact.status === 0 && reading.artifact.errorCode
          ? reading.artifact.errorCode
          : "robots_unavailable";
      };
      const targetVerdict = await robotsVerdict(target);
      const targetAllowed = targetVerdict === true;
      const declaredSitemaps = parsedRobots.sitemaps
        .map((value) => canonicalSameSiteUrl(value, target, usedHttpFallback))
        .filter((value): value is URL => value !== undefined)
        .slice(0, 3);
      const sitemapTargets = declaredSitemaps.length
        ? declaredSitemaps
        : [discoveryUrl(target, "/sitemap.xml")];
      const fetchIfRobotsAllowed = async (
        url: URL,
        fetchOptions: Parameters<SafeFetcher["fetch"]>[1],
      ): Promise<FetchArtifact> => {
        const refusal = await admit(url);
        return refusal ? unavailableArtifact(url, refusal) : fetch(url, { ...fetchOptions, admit });
      };

      const contentPromise = targetAllowed
        ? Promise.all([
            fetch(target, { bodyLimit: 2 * 1024 * 1024, admit }),
            fetch(target, {
              bodyLimit: 2 * 1024 * 1024,
              accept: "text/markdown",
              admit,
            }),
            fetch(target, {
              bodyLimit: 2 * 1024 * 1024,
              userAgent: asAgent("ChatGPT-User/1.0"),
              admit,
            }),
            fetch(target, {
              bodyLimit: 2 * 1024 * 1024,
              userAgent: asAgent("Claude-User"),
              admit,
            }),
          ])
        : Promise.resolve([]);
      const sitemapPromise = (async () => {
        const pending = [...sitemapTargets];
        const seen = new Set<string>();
        const artifacts: FetchArtifact[] = [];
        while (artifacts.length < 3) {
          const url = pending.shift();
          if (!url) break;
          const key = url.toString();
          if (seen.has(key)) continue;
          seen.add(key);
          const artifact = await fetchIfRobotsAllowed(url, {
            bodyLimit: 5 * 1024 * 1024,
            accept: "application/xml,text/xml,*/*;q=0.1",
          });
          artifacts.push(artifact);
          if (artifact.errorCode || artifact.status < 200 || artifact.status >= 300) continue;
          const parsed = parseSitemap(artifact.body);
          if (!parsed.valid || !parsed.isIndex) continue;
          const children = parsed.urls
            .map((value) => canonicalSameSiteUrl(value, target, usedHttpFallback))
            .filter((value): value is URL => value !== undefined && !seen.has(value.toString()));
          pending.unshift(...children);
        }
        return artifacts;
      })();
      const llmsUrl = discoveryUrl(target, "/llms.txt");
      const llmsPromise = fetchIfRobotsAllowed(llmsUrl, {
        bodyLimit: 512 * 1024,
        accept: "text/plain,text/markdown,*/*;q=0.1",
      });
      const mcpUrl = discoveryUrl(target, "/.well-known/mcp.json");
      const mcpCardUrl = discoveryUrl(target, "/.well-known/mcp/server-card.json");
      const ucpUrl = discoveryUrl(target, "/.well-known/ucp");
      const a2aUrl = discoveryUrl(target, "/.well-known/agent-card.json");
      const wellKnown = Promise.all([
        fetchIfRobotsAllowed(mcpUrl, {
          bodyLimit: 1024 * 1024,
          accept: "application/json,*/*;q=0.1",
        }),
        fetchIfRobotsAllowed(mcpCardUrl, {
          bodyLimit: 1024 * 1024,
          accept: "application/json,*/*;q=0.1",
        }),
        ...(job.segment === "store"
          ? [
              fetchIfRobotsAllowed(ucpUrl, {
                bodyLimit: 1024 * 1024,
                accept: "application/json,*/*;q=0.1",
              }),
            ]
          : []),
        fetchIfRobotsAllowed(a2aUrl, {
          bodyLimit: 1024 * 1024,
          accept: "application/json,*/*;q=0.1",
        }),
      ]);

      const [contentResults, sitemap, llms, knownResults] = await Promise.all([
        contentPromise,
        sitemapPromise,
        llmsPromise,
        wellKnown,
      ]);
      // The well-known batch answers in the order it was assembled: the two
      // MCP documents, the UCP document for a store, and the A2A document.
      const [mcpWellKnown, mcpServerCard, ...furtherKnown] = knownResults;
      const mcp = [mcpWellKnown, mcpServerCard].filter((artifact) => artifact !== undefined);
      const ucp = job.segment === "store" ? furtherKnown[0] : undefined;
      const a2a = job.segment === "store" ? furtherKnown[1] : furtherKnown[0];
      const phaseArtifacts: ScanArtifacts = {
        segment: job.segment,
        canonicalTargetUrl: target.toString(),
        robots,
        ...(contentResults[0] ? { base: contentResults[0] } : {}),
        ...(contentResults[1] ? { markdown: contentResults[1] } : {}),
        agentProbes: {
          ...(contentResults[2] ? { chatgpt: contentResults[2] } : {}),
          ...(contentResults[3] ? { claude: contentResults[3] } : {}),
        },
        sitemap,
        llms,
        mcp,
        ...(ucp ? { ucp } : {}),
        oauth: [],
        ...(a2a ? { a2a } : {}),
      };
      await emitChecks(phaseArtifacts, [4, 7, 8, 9, 10, 13, 14, 16, 17, 18]);

      const oauthPromise = authDeclared(phaseArtifacts)
        ? Promise.all([
            fetchIfRobotsAllowed(discoveryUrl(target, "/.well-known/oauth-authorization-server"), {
              bodyLimit: 1024 * 1024,
              accept: "application/json,*/*;q=0.1",
            }),
            fetchIfRobotsAllowed(discoveryUrl(target, "/.well-known/oauth-protected-resource"), {
              bodyLimit: 1024 * 1024,
              accept: "application/json,*/*;q=0.1",
            }),
          ])
        : Promise.resolve([]);
      const representativePromise =
        job.segment === "store" && robotsDecisionKnown && targetAllowed
          ? (async () => {
              const found = productCandidates(target, sitemap, usedHttpFallback);
              const refusals = await Promise.all(found.map(admit));
              const candidates = found.filter((_, index) => !refusals[index]);
              // A product page robots.txt keeps the scanner off still tells the
              // engine why the store's product data went unread.
              const [firstFound] = found;
              const [firstRefusal] = refusals;
              if (!candidates.length && firstFound && firstRefusal)
                return unavailableArtifact(firstFound, firstRefusal);
              const heads = await Promise.all(
                candidates.map((candidate) =>
                  fetch(candidate, {
                    method: "HEAD",
                    bodyLimit: 0,
                    accept: "text/html,*/*;q=0.1",
                    admit,
                  }),
                ),
              );
              const successfulIndex = heads.findIndex(
                (head) => head.status >= 200 && head.status < 400,
              );
              const unsupportedHeadIndex = heads.findIndex((head) =>
                [405, 501].includes(head.status),
              );
              const index = successfulIndex === -1 ? unsupportedHeadIndex : successfulIndex;
              // With no candidate answering HEAD with a page, the first answer,
              // an error status or a failure, tells the engine why none was
              // read. It is not asked again with GET: a page gone or a rate
              // limit answers GET the same, and the request is the scan's.
              if (index === -1) return heads[0];
              const representative = candidates[index];
              return representative
                ? await fetch(representative, {
                    bodyLimit: 2 * 1024 * 1024,
                    admit,
                  })
                : undefined;
            })()
          : Promise.resolve(undefined);
      const [oauth, representative] = await Promise.all([oauthPromise, representativePromise]);
      const artifacts: ScanArtifacts = {
        ...phaseArtifacts,
        oauth,
        ...(representative ? { representative } : {}),
      };
      const evaluation = evaluateScan(artifacts);
      await emitChecks(
        artifacts,
        evaluation.checks.map(({ id }) => id),
      );
      this.dependencies.emitMetric?.({
        name: "scan_requests",
        value: budget.used,
      });
      this.dependencies.emitMetric?.({
        name: "scan_coverage",
        value: evaluation.score.coverage,
      });
      this.dependencies.emitMetric?.({
        name: "scan_duration_ms",
        value: (this.dependencies.now ?? Date.now)() - startedAt,
      });
      return { ...evaluation, requestCount: budget.used };
    } finally {
      clearTimeout(deadlineTimer);
    }
  }
}
