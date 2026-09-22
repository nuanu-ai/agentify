export type RobotsGroup = {
  agents: string[];
  allow: string[];
  disallow: string[];
};

export type RobotsParseResult = {
  groups: RobotsGroup[];
  sitemaps: string[];
  contentSignal?: Record<string, "yes" | "no">;
  contentSignalMalformed: boolean;
  malformedDirectives: number;
  fatal: boolean;
};

const CONTENT_SIGNAL_KEYS = new Set(["search", "ai-input", "ai-train"]);

export const parseRobots = (body: string): RobotsParseResult => {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | undefined;
  let seenRules = false;
  let malformedDirectives = 0;
  let contentSignalMalformed = false;
  let contentSignal: Record<string, "yes" | "no"> | undefined;

  for (const original of body.split(/\r?\n/)) {
    const line = original.replace(/\s+#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) {
      malformedDirectives += 1;
      continue;
    }
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (!current || seenRules) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
        seenRules = false;
      }
      if (value) current.agents.push(value.toLowerCase());
      else malformedDirectives += 1;
    } else if (field === "allow" || field === "disallow") {
      if (!current) malformedDirectives += 1;
      else {
        current[field].push(value);
        seenRules = true;
      }
    } else if (field === "sitemap") {
      if (/^https?:\/\//i.test(value) && sitemaps.length < 20)
        sitemaps.push(value);
      else malformedDirectives += 1;
    } else if (field === "content-signal") {
      const parsed: Record<string, "yes" | "no"> = {};
      for (const token of value.split(/[;,]/)) {
        const [rawKey, rawValue, ...rest] = token.trim().split(/\s*=\s*/);
        const key = rawKey?.toLowerCase();
        const setting = rawValue?.toLowerCase();
        if (
          rest.length ||
          !key ||
          !CONTENT_SIGNAL_KEYS.has(key) ||
          (setting !== "yes" && setting !== "no")
        ) {
          contentSignalMalformed = true;
          continue;
        }
        parsed[key] = setting;
      }
      if (Object.keys(parsed).length)
        contentSignal = { ...contentSignal, ...parsed };
    }
  }

  return {
    groups,
    sitemaps,
    contentSignal,
    contentSignalMalformed,
    malformedDirectives,
    fatal: body.includes("\0"),
  };
};

const ruleMatches = (path: string, rule: string): boolean => {
  if (!rule) return false;
  const escaped = rule
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\$$/, "$");
  return new RegExp(`^${escaped}`).test(path);
};

export const isPathAllowed = (
  parsed: RobotsParseResult,
  userAgent: string,
  path: string,
): boolean => {
  const normalized = userAgent.toLowerCase();
  const groupsWithSpecificity = parsed.groups.map((group) => ({
    group,
    specificity: Math.max(
      -1,
      ...group.agents.map((agent) => {
        if (agent === "*") return 0;
        return normalized.includes(agent) ? agent.length : -1;
      }),
    ),
  }));
  const maxSpecificity = Math.max(
    -1,
    ...groupsWithSpecificity.map(({ specificity }) => specificity),
  );
  const groups = groupsWithSpecificity
    .filter(
      ({ specificity }) => specificity === maxSpecificity && specificity >= 0,
    )
    .map(({ group }) => group);
  const rules = groups.flatMap((group) => [
    ...group.allow.map((rule) => ({ rule, allow: true })),
    ...group.disallow.map((rule) => ({ rule, allow: false })),
  ]);
  const matches = rules
    .filter(({ rule }) => ruleMatches(path, rule))
    .sort((a, b) => b.rule.length - a.rule.length);
  const [closest] = matches;
  if (!closest) return true;
  const longest = closest.rule.length;
  return matches
    .filter(({ rule }) => rule.length === longest)
    .some(({ allow }) => allow);
};

const PROVIDERS: ReadonlyArray<readonly [string, string[]]> = [
  ["openai", ["gptbot", "oai-searchbot", "chatgpt-user"]],
  ["anthropic", ["claudebot", "claude-user"]],
  ["perplexity", ["perplexitybot"]],
  ["google", ["google-extended"]],
];

export const explicitAiPolicies = (
  parsed: RobotsParseResult,
): Record<string, string[]> => {
  const output: Record<string, string[]> = {};
  const tokens = new Set(
    parsed.groups.flatMap((group) =>
      group.agents.map((agent) => agent.replace(/\/[\d.]+$/, "")),
    ),
  );
  for (const [provider, agents] of PROVIDERS) {
    const found = agents.filter((agent) => tokens.has(agent));
    if (found.length) output[provider] = found;
  }
  return output;
};
