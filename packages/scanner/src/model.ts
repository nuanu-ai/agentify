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
};

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
  noncanonicalA2aHint?: boolean;
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

export type FingerprintSignal = {
  value: string;
  confidence: "high" | "medium" | "low";
  signals: string[];
};

export type ScanEvaluation = {
  checks: CheckResult[];
  score: ScanScore;
  fingerprint: {
    detectorVersion: string;
    platform: FingerprintSignal;
    wafCdn: FingerprintSignal[];
    pspMarkers: FingerprintSignal[];
  };
  findings: {
    negativeCheckIds: number[];
    positiveCheckId?: number;
  };
};
