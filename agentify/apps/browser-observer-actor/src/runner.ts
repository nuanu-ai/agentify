import {
  BROWSER_OBSERVATION_VERSION,
  browserObservationInputV1Schema,
  type BrowserObservationInputV1,
  type BrowserObservationOutputV1,
} from "@b2a/contracts";
import {
  isPathAllowed,
  parseRobots,
  type RobotsParseResult,
} from "@b2a/scanner-core";
import {
  chromium,
  type Browser,
  type ConsoleMessage,
  type Page,
  type Request,
} from "playwright";

import { collectPageSignals, type PageSignals } from "./browser-signals.js";
import {
  BrowserNetworkPolicyError,
  inspectRequest,
  resolveSafeNavigationRedirect,
  resolvePublicHost,
  safeBrowserRequest,
  validateActorTarget,
} from "./network-policy.js";
import {
  aggregateBrowserSignals,
  buildObservations,
  type ObservationRuntime,
} from "./observations.js";
import { discoverRepresentativeUrls } from "./representative-pages.js";
import {
  installPassiveRuntimeGuards,
  PASSIVE_BROWSER_ARGS,
} from "./runtime-guards.js";
import {
  OutputSanitizationError,
  sanitizeBrowserOutput,
} from "./sanitize-output.js";

const HONEST_USER_AGENT =
  "agentify-browser-observer/1.0 (+https://agentify.ad/scanner)";

export const raceWithAbort = async <T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> => {
  if (signal.aborted) {
    throw new BrowserNetworkPolicyError("run_timeout");
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(new BrowserNetworkPolicyError("run_timeout"));
    };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
};

export const settleWithin = async (
  operation: Promise<unknown>,
  timeoutMs = 2_000,
): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    operation.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref();
    }),
  ]);
  if (timer) clearTimeout(timer);
};

const categorizeConsole = (message: ConsoleMessage): string | null => {
  if (message.type() !== "error" && message.type() !== "assert") return null;
  const text = message.text().toLowerCase();
  if (/content security policy|\bcsp\b/.test(text)) return "csp";
  if (/failed to fetch|networkerror|net::/.test(text)) return "network";
  if (/syntaxerror|unexpected token/.test(text)) return "syntax";
  if (/referenceerror|is not defined/.test(text)) return "reference";
  if (/typeerror|cannot read|is not a function/.test(text)) return "type";
  if (/permission|notallowederror/.test(text)) return "permission";
  if (/unhandled|uncaught.*promise/.test(text)) return "unhandled_promise";
  return "other";
};

const categorizePageError = (error: Error): string => {
  const name = error.name.toLowerCase();
  if (name.includes("syntax")) return "syntax";
  if (name.includes("reference")) return "reference";
  if (name.includes("type")) return "type";
  return "unhandled_exception";
};

const resourceFailureCategory = (request: Request): string => {
  const type = request.resourceType();
  return [
    "document",
    "stylesheet",
    "image",
    "media",
    "font",
    "script",
    "texttrack",
    "xhr",
    "fetch",
    "eventsource",
    "manifest",
    "other",
  ].includes(type)
    ? type
    : "other";
};

const emptyRuntime = (
  input: BrowserObservationInputV1,
): ObservationRuntime & {
  consoleErrorCategories: string[];
  failedResourceCategories: string[];
  pages: PageSignals[];
} => ({
  pages: [],
  consoleErrorCategories: [],
  failedResourceCategories: [],
  mixedContentCount: 0,
  requestCount: 0,
  transferredBytes: 0,
  blockedMutationCount: 0,
  blockedDestinationCount: 0,
  byteBudgetExceeded: false,
  requestBudgetExceeded: false,
  pageFailureCount: 0,
  maxTotalBytes: input.limits.max_total_bytes,
  maxRequests:
    input.limits.max_pages * (input.limits.max_requests_per_page + 1),
});

const consumeRuntimeBytes = (
  runtime: ReturnType<typeof emptyRuntime>,
  input: BrowserObservationInputV1,
  bytes: number,
): boolean => {
  if (runtime.transferredBytes + bytes > input.limits.max_total_bytes) {
    runtime.byteBudgetExceeded = true;
    return false;
  }
  runtime.transferredBytes += bytes;
  return true;
};

type RobotsCacheValue =
  | { kind: "allow_all" }
  | { kind: "parsed"; value: RobotsParseResult }
  | { kind: "blocked" };

export const permitsSearchPurpose = (parsed: RobotsParseResult): boolean =>
  parsed.contentSignal?.search !== "no";

export const permitsBrowserNavigation = (
  parsed: RobotsParseResult,
  pathname: string,
): boolean =>
  permitsSearchPurpose(parsed) &&
  isPathAllowed(parsed, "agentify-browser-observer", pathname);

export const authorizeMainFrameNavigation = async (options: {
  isNavigation: boolean;
  isMainFrame: boolean;
  url: URL;
  checkRobots: (url: URL) => Promise<boolean>;
}): Promise<boolean> =>
  !options.isNavigation ||
  !options.isMainFrame ||
  (await options.checkRobots(options.url));

const robotsAllows = async (options: {
  url: URL;
  input: BrowserObservationInputV1;
  runtime: ReturnType<typeof emptyRuntime>;
  signal: AbortSignal;
  cache: Map<string, RobotsCacheValue>;
}): Promise<boolean> => {
  let cached = options.cache.get(options.url.origin);
  if (!cached) {
    options.runtime.requestCount += 1;
    let robotsBytes = 0;
    try {
      let robotsUrl = new URL("/robots.txt", options.url.origin);
      let response;
      for (let redirectCount = 0; ; redirectCount += 1) {
        response = await safeBrowserRequest({
          url: robotsUrl,
          method: "GET",
          headers: {
            accept: "text/plain,*/*;q=0.1",
            "user-agent": options.input.policy.user_agent,
          },
          signal: options.signal,
          timeoutMs: Math.min(8_000, options.input.limits.page_timeout_ms),
          consumeBytes: (bytes) => {
            robotsBytes += bytes;
            if (robotsBytes > 512 * 1024) return false;
            return consumeRuntimeBytes(options.runtime, options.input, bytes);
          },
        });
        const location = response.headers.location;
        if (!location || ![301, 302, 303, 307, 308].includes(response.status))
          break;
        if (redirectCount >= 2) {
          throw new BrowserNetworkPolicyError("redirect_limit");
        }
        robotsUrl = resolveSafeNavigationRedirect({
          allowedDomain: options.input.target.registrable_domain,
          from: robotsUrl,
          location,
        });
        options.runtime.requestCount += 1;
        if (options.runtime.requestCount > options.runtime.maxRequests) {
          options.runtime.requestBudgetExceeded = true;
          throw new BrowserNetworkPolicyError("request_budget_exceeded");
        }
      }
      if (response.status === 404 || response.status === 410) {
        cached = { kind: "allow_all" };
      } else if (response.status >= 200 && response.status < 300) {
        const parsed = parseRobots(response.body.toString("utf8"));
        cached =
          parsed.fatal || !permitsSearchPurpose(parsed)
            ? { kind: "blocked" }
            : { kind: "parsed", value: parsed };
      } else {
        cached = { kind: "blocked" };
      }
    } catch {
      cached = { kind: "blocked" };
    }
    options.cache.set(options.url.origin, cached);
  }
  if (cached.kind === "blocked") return false;
  if (cached.kind === "allow_all") return true;
  return permitsBrowserNavigation(cached.value, options.url.pathname);
};

const safeActorBuild = (value: string): string => {
  const normalized = value.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 200);
  return normalized || "local-dev";
};

export const resolveActorBuild = (
  environment: Readonly<Record<string, string | undefined>>,
): string =>
  environment.ACTOR_BUILD_NUMBER ??
  environment.APIFY_ACTOR_BUILD_NUMBER ??
  environment.APIFY_ACTOR_BUILD_ID ??
  environment.ACTOR_BUILD_ID ??
  "local-dev";

const safeRuntimeFailureCode = (error: unknown): string => {
  if (error instanceof BrowserNetworkPolicyError) return error.code;
  if (error instanceof OutputSanitizationError) return error.code;
  if (error instanceof Error && error.name === "ZodError") {
    return "output_schema_invalid";
  }
  const safeName =
    error && typeof error === "object" && "name" in error
      ? (error as { name?: unknown }).name
      : undefined;
  if (typeof safeName === "string" && /^[A-Za-z]+Error$/.test(safeName)) {
    return `browser_runtime_${safeName
      .replace(/Error$/, "")
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .toLowerCase()}_error`;
  }
  const safeCode =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (typeof safeCode === "string" && /^[A-Z][A-Z0-9_]{1,80}$/.test(safeCode)) {
    return `browser_runtime_${safeCode.toLowerCase()}`;
  }
  return "browser_runtime_failed";
};

const failureOutput = (options: {
  input: BrowserObservationInputV1;
  actorBuild: string;
  startedAt: number;
}): BrowserObservationOutputV1 => {
  const runtime = emptyRuntime(options.input);
  return sanitizeBrowserOutput({
    schema_version: BROWSER_OBSERVATION_VERSION,
    operation_id: options.input.operation_id,
    actor_build: safeActorBuild(options.actorBuild),
    status: "failed",
    pages_assessed: 0,
    signals: aggregateBrowserSignals(runtime),
    observations: buildObservations(runtime),
    timings: {
      total_ms: Math.min(120_000, Date.now() - options.startedAt),
      pages: [],
    },
  });
};

const observePage = async (options: {
  browser: Browser;
  url: URL;
  input: BrowserObservationInputV1;
  runtime: ReturnType<typeof emptyRuntime>;
  runSignal: AbortSignal;
  robotsCache: Map<string, RobotsCacheValue>;
}): Promise<{
  signals: PageSignals;
  durationMs: number;
  representativeUrls: URL[];
}> => {
  const startedAt = Date.now();
  const context = await raceWithAbort(
    options.browser.newContext({
      acceptDownloads: false,
      bypassCSP: false,
      ignoreHTTPSErrors: false,
      javaScriptEnabled: true,
      locale: "en-US",
      serviceWorkers: "block",
      userAgent: options.input.policy.user_agent,
      viewport: { width: 1280, height: 900 },
    }),
    options.runSignal,
  );
  await installPassiveRuntimeGuards(context);
  await context.clearPermissions();
  await context.routeWebSocket(/.*/, async (socket) => {
    options.runtime.blockedDestinationCount += 1;
    await socket.close({ code: 1008, reason: "policy" });
  });

  let primaryPage: Page | undefined;
  let rawHtml = "";
  let pageRequestCount = 0;
  const policyBlocked = new WeakSet<Request>();
  const pageAbort = new AbortController();
  let pageStage: "setup" | "new_page" | "navigation" | "load" | "extraction" =
    "setup";
  const abortPage = (): void => {
    pageAbort.abort();
    void settleWithin(context.close({ reason: "run_deadline" }));
  };
  options.runSignal.addEventListener("abort", abortPage, { once: true });

  try {
    await context.route("**/*", async (route) => {
      const request = route.request();
      pageRequestCount += 1;
      options.runtime.requestCount += 1;
      if (
        pageRequestCount > options.input.limits.max_requests_per_page ||
        options.runtime.requestCount > options.runtime.maxRequests
      ) {
        options.runtime.requestBudgetExceeded = true;
        policyBlocked.add(request);
        await route.abort("blockedbyclient");
        return;
      }

      const redirectedFrom = request.redirectedFrom();
      const decision = inspectRequest({
        url: request.url(),
        method: request.method(),
        isNavigation: request.isNavigationRequest(),
        allowedDomain: options.input.target.registrable_domain,
        redirectedFromUrl: redirectedFrom?.url(),
      });
      if (!decision.allowed) {
        policyBlocked.add(request);
        if (decision.code === "method_blocked") {
          options.runtime.blockedMutationCount += 1;
        } else {
          options.runtime.blockedDestinationCount += 1;
        }
        await route.abort("blockedbyclient");
        return;
      }

      const navigationAllowed = await authorizeMainFrameNavigation({
        isNavigation: request.isNavigationRequest(),
        isMainFrame: request.frame() === primaryPage?.mainFrame(),
        url: decision.url,
        checkRobots: async (url) =>
          await robotsAllows({
            url,
            input: options.input,
            runtime: options.runtime,
            signal: pageAbort.signal,
            cache: options.robotsCache,
          }),
      });
      if (!navigationAllowed) {
        policyBlocked.add(request);
        options.runtime.blockedDestinationCount += 1;
        pageAbort.abort();
        await route.abort("blockedbyclient");
        return;
      }

      if (
        options.url.protocol === "https:" &&
        decision.url.protocol === "http:"
      ) {
        options.runtime.mixedContentCount += 1;
      }

      try {
        const response = await safeBrowserRequest({
          url: decision.url,
          method: request.method() as "GET" | "HEAD",
          headers: await request.allHeaders(),
          signal: pageAbort.signal,
          timeoutMs: Math.min(8_000, options.input.limits.page_timeout_ms),
          consumeBytes: (bytes) => {
            if (!consumeRuntimeBytes(options.runtime, options.input, bytes)) {
              pageAbort.abort();
              return false;
            }
            return true;
          },
        });
        if (
          request.isNavigationRequest() &&
          request.frame() === primaryPage?.mainFrame() &&
          response.status >= 200 &&
          response.status < 400 &&
          (response.headers["content-type"] ?? "")
            .toLowerCase()
            .includes("text/html")
        ) {
          rawHtml = response.body.toString("utf8");
        }
        if (response.status >= 400) {
          options.runtime.failedResourceCategories.push(
            resourceFailureCategory(request),
          );
        }
        await route.fulfill({
          status: response.status,
          headers: response.headers,
          body: request.method() === "HEAD" ? undefined : response.body,
        });
      } catch (error) {
        policyBlocked.add(request);
        if (
          error instanceof BrowserNetworkPolicyError &&
          (error.code === "ssrf_blocked" || error.code === "dns_no_answers")
        ) {
          options.runtime.blockedDestinationCount += 1;
        }
        await route.abort("blockedbyclient").catch(() => undefined);
      }
    });

    context.on("page", (page) => {
      if (primaryPage && page !== primaryPage) {
        void page.close({ runBeforeUnload: false });
      }
    });
    pageStage = "new_page";
    primaryPage = await raceWithAbort(context.newPage(), options.runSignal);
    primaryPage.on("console", (message) => {
      const category = categorizeConsole(message);
      if (category) options.runtime.consoleErrorCategories.push(category);
    });
    primaryPage.on("pageerror", (error) => {
      options.runtime.consoleErrorCategories.push(categorizePageError(error));
    });
    primaryPage.on("requestfailed", (request) => {
      if (!policyBlocked.has(request)) {
        options.runtime.failedResourceCategories.push(
          resourceFailureCategory(request),
        );
      }
    });
    primaryPage.on("dialog", (dialog) => {
      void dialog.dismiss();
    });
    primaryPage.on("download", (download) => {
      void download.cancel();
    });
    primaryPage.on("framenavigated", (frame) => {
      if (frame !== primaryPage?.mainFrame()) return;
      const decision = inspectRequest({
        url: frame.url(),
        method: "GET",
        isNavigation: true,
        allowedDomain: options.input.target.registrable_domain,
      });
      if (!decision.allowed) {
        options.runtime.blockedDestinationCount += 1;
        pageAbort.abort();
        void primaryPage?.close({ runBeforeUnload: false });
      }
    });

    pageStage = "navigation";
    await raceWithAbort(
      primaryPage.goto(options.url.toString(), {
        waitUntil: "domcontentloaded",
        timeout: options.input.limits.page_timeout_ms,
      }),
      options.runSignal,
    );
    pageStage = "load";
    await primaryPage
      .waitForLoadState("load", {
        timeout: Math.min(1_500, options.input.limits.page_timeout_ms),
      })
      .catch(() => undefined);
    if (pageAbort.signal.aborted || options.runSignal.aborted) {
      throw new BrowserNetworkPolicyError("page_aborted");
    }
    pageStage = "extraction";
    const extraction = Promise.all([
      collectPageSignals({
        page: primaryPage,
        rawHtml,
        rawUrl: options.url.toString(),
        timeoutMs: options.input.limits.page_timeout_ms,
      }),
      discoverRepresentativeUrls({
        page: primaryPage,
        baseUrl: options.url.toString(),
        allowedDomain: options.input.target.registrable_domain,
        limit: 2,
      }),
    ]);
    const [signals, representativeUrls] = await raceWithAbort(
      extraction,
      options.runSignal,
    );
    return {
      signals,
      durationMs: Date.now() - startedAt,
      representativeUrls,
    };
  } catch (error) {
    const code = safeRuntimeFailureCode(error);
    throw new BrowserNetworkPolicyError(
      code === "browser_runtime_failed"
        ? `${pageStage}_failed`
        : `${pageStage}_${code}`,
    );
  } finally {
    options.runSignal.removeEventListener("abort", abortPage);
    await settleWithin(context.close({ reason: "observation_complete" }));
  }
};

export const runBrowserObservation = async (options: {
  input: unknown;
  actorBuild: string;
  onRuntimeFailure?: (code: string) => void;
}): Promise<BrowserObservationOutputV1> => {
  const input = browserObservationInputV1Schema.parse(options.input);
  if (input.policy.user_agent !== HONEST_USER_AGENT) {
    throw new BrowserNetworkPolicyError("user_agent_policy_mismatch");
  }
  const actorBuild = safeActorBuild(options.actorBuild);
  const startedAt = Date.now();
  const urls = validateActorTarget({
    canonicalUrl: input.target.canonical_url,
    representativeUrls: input.representative_urls,
    declaredDomain: input.target.registrable_domain,
  }).slice(0, input.limits.max_pages);
  const runtime = emptyRuntime(input);
  const timings: number[] = [];
  const runController = new AbortController();
  let runtimeStage: "robots" | "launch" | "page" | "output" = "robots";
  let browser: Browser | undefined;
  const runTimer = setTimeout(() => {
    runController.abort();
    if (browser) void settleWithin(browser.close());
  }, input.limits.run_timeout_ms);
  runTimer.unref();

  try {
    const allowedUrls: URL[] = [];
    const robotsCache = new Map<string, RobotsCacheValue>();
    for (const [index, url] of urls.entries()) {
      const allowed = await robotsAllows({
        url,
        input,
        runtime,
        signal: runController.signal,
        cache: robotsCache,
      });
      if (allowed) {
        allowedUrls.push(url);
      } else if (index === 0) {
        return sanitizeBrowserOutput({
          schema_version: BROWSER_OBSERVATION_VERSION,
          operation_id: input.operation_id,
          actor_build: actorBuild,
          status: "blocked",
          pages_assessed: 0,
          signals: aggregateBrowserSignals(runtime),
          observations: buildObservations(runtime),
          timings: {
            total_ms: Math.min(120_000, Date.now() - startedAt),
            pages: [],
          },
        });
      } else {
        runtime.pageFailureCount += 1;
      }
    }

    runtimeStage = "launch";
    const browserLaunch = chromium.launch({
      headless: true,
      args: [...PASSIVE_BROWSER_ARGS],
      timeout: Math.min(15_000, input.limits.run_timeout_ms),
    });
    void browserLaunch
      .then(async (launched) => {
        if (runController.signal.aborted) await launched.close();
      })
      .catch(() => undefined);
    browser = await raceWithAbort(browserLaunch, runController.signal);
    runtimeStage = "page";
    for (let pageIndex = 0; pageIndex < allowedUrls.length; pageIndex += 1) {
      const url = allowedUrls[pageIndex]!;
      if (runController.signal.aborted) break;
      try {
        const result = await observePage({
          browser,
          url,
          input,
          runtime,
          runSignal: runController.signal,
          robotsCache,
        });
        runtime.pages.push(result.signals);
        timings.push(result.durationMs);
        if (pageIndex === 0 && allowedUrls.length < input.limits.max_pages) {
          for (const candidate of result.representativeUrls) {
            if (allowedUrls.length >= input.limits.max_pages) break;
            if (
              allowedUrls.some(
                (existing) => existing.toString() === candidate.toString(),
              )
            ) {
              continue;
            }
            try {
              await resolvePublicHost(candidate.hostname);
              const allowed = await robotsAllows({
                url: candidate,
                input,
                runtime,
                signal: runController.signal,
                cache: robotsCache,
              });
              if (allowed) allowedUrls.push(candidate);
              else runtime.pageFailureCount += 1;
            } catch {
              runtime.pageFailureCount += 1;
            }
          }
        }
      } catch (error) {
        options.onRuntimeFailure?.(`page_${safeRuntimeFailureCode(error)}`);
        runtime.pageFailureCount += 1;
      }
      if (runtime.byteBudgetExceeded || runtime.requestBudgetExceeded) break;
    }

    const signals = aggregateBrowserSignals(runtime);
    const status =
      runtime.pages.length === 0
        ? "failed"
        : signals.challenge_kind
          ? "blocked"
          : runtime.pageFailureCount > 0 ||
              runtime.byteBudgetExceeded ||
              runtime.requestBudgetExceeded ||
              runController.signal.aborted
            ? "partial"
            : "completed";
    runtimeStage = "output";
    return sanitizeBrowserOutput({
      schema_version: BROWSER_OBSERVATION_VERSION,
      operation_id: input.operation_id,
      actor_build: actorBuild,
      status,
      pages_assessed: runtime.pages.length,
      signals,
      observations: buildObservations(runtime),
      timings: {
        total_ms: Math.min(120_000, Date.now() - startedAt),
        pages: timings.map((value) => Math.min(60_000, value)),
      },
    });
  } catch (error) {
    const code = safeRuntimeFailureCode(error);
    options.onRuntimeFailure?.(
      code === "browser_runtime_failed"
        ? `browser_${runtimeStage}_failed`
        : `${runtimeStage}_${code}`,
    );
    return failureOutput({ input, actorBuild, startedAt });
  } finally {
    clearTimeout(runTimer);
    if (browser) await settleWithin(browser.close());
  }
};
