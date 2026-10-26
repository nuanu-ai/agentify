import type { CheckResult, Segment } from "@agentify/scanner-contracts";

export type SafeHeaderName =
  | "content-type"
  | "vary"
  | "server"
  | "via"
  | "x-powered-by"
  | "x-cache"
  | "www-authenticate"
  | "link";

export type FetchArtifact = {
  url: string;
  status: number;
  headers: Partial<Record<SafeHeaderName, string>>;
  body: string;
  decodedBytes: number;
  truncated: boolean;
  durationMs: number;
  ttfbMs: number;
  errorCode?: string;
  /** Transient redirect target; never persisted in check evidence. */
  redirectLocation?: string;
  /**
   * The address asked for, when redirects led to `url`; never persisted in
   * check evidence.
   */
  requestedUrl?: string;
};

/**
 * The error code of a body that is a gzip file the fetch could not unpack,
 * which is kept with the status the site answered.
 */
export const GZIP_UNPACKING_FAILED = "gzip_unpacking_failed";

/** How many sitemap files a scan reads at most, an index and what it lists included. */
export const SITEMAP_FILE_LIMIT = 3;

export type ScanArtifacts = {
  segment: Segment;
  canonicalTargetUrl: string;
  robots: FetchArtifact;
  base?: FetchArtifact;
  representative?: FetchArtifact;
  markdown?: FetchArtifact;
  agentProbes: Partial<Record<"chatgpt" | "claude", FetchArtifact>>;
  sitemap: FetchArtifact[];
  llms?: FetchArtifact;
  mcp: FetchArtifact[];
  ucp?: FetchArtifact;
  oauth: FetchArtifact[];
  a2a?: FetchArtifact;
};

export type ScanScore = {
  rubricVersion: "gtm-v1.0.0";
  score: number | null;
  coverage: number;
  level: "invisible" | "readable" | "callable_ready" | "ahead_of_market" | "incomplete";
  terminalStatus: "completed" | "partial" | "failed";
  nominalWeight: number;
  applicableWeight: number;
  assessedWeight: number;
  earnedWeight: number;
};

export type ScanEvaluation = {
  checks: CheckResult[];
  score: ScanScore;
  findings: {
    negativeCheckIds: number[];
    positiveCheckId?: number;
  };
};
