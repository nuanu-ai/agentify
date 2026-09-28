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
    const comment = original.indexOf("#");
    const line = (comment === -1 ? original : original.slice(0, comment)).trim();
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
      if (/^https?:\/\//i.test(value) && sitemaps.length < 20) sitemaps.push(value);
      else malformedDirectives += 1;
    } else if (field === "content-signal") {
      const parsed: Record<string, "yes" | "no"> = {};
      for (const token of value.split(/[;,]/)) {
        const [rawKey, rawValue, ...rest] = token.split("=").map((part) => part.trim());
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
      if (Object.keys(parsed).length) contentSignal = { ...contentSignal, ...parsed };
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

// RFC 9309: a rule matches from the start of the path, "*" stands for any run
// of characters, the empty one included, and "$" at the end of the rule for
// the end of the path. The site writes the rule, so it is not compiled into a
// RegExp, which backtracks without bound over a run of wildcards and throws
// on a rule longer than its size limit. Taking each piece between wildcards
// at its first occurrence after the previous one never misses a match that
// exists, so the path is searched once per piece.
const ruleMatches = (path: string, rule: string): boolean => {
  if (!rule) return false;
  const anchored = rule.endsWith("$");
  const [head = "", ...pieces] = (anchored ? rule.slice(0, -1) : rule).split("*");
  if (!path.startsWith(head)) return false;
  const tail = pieces.pop();
  if (tail === undefined) return !anchored || path.length === head.length;
  let position = head.length;
  for (const piece of pieces) {
    const found = path.indexOf(piece, position);
    if (found === -1) return false;
    position = found + piece.length;
  }
  return anchored
    ? path.length - tail.length >= position && path.endsWith(tail)
    : path.includes(tail, position);
};

// A rule with a wildcard is searched for along the whole path, so a decision
// costs up to the number of such rules times the path's length. Past this
// product the decision is not made; at the edge the worst matching measured
// under 90 ms.
// The largest real file measured, Etsy's, applies 900 wildcard rules to every
// crawler, which this admits against paths of up to 9,000 characters.
const DECISION_BUDGET = 8 * 1024 * 1024;

// true or false for the path, or undefined when deciding would cost more
// than DECISION_BUDGET: "robots.txt could not be assessed", never a guess.
export const isPathAllowed = (
  parsed: RobotsParseResult,
  userAgent: string,
  path: string,
): boolean | undefined => {
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
    .filter(({ specificity }) => specificity === maxSpecificity && specificity >= 0)
    .map(({ group }) => group);
  const rules = groups.flatMap((group) => [
    ...group.allow.map((rule) => ({ rule, allow: true })),
    ...group.disallow.map((rule) => ({ rule, allow: false })),
  ]);
  const wildcardRules = rules.filter(({ rule }) => rule.includes("*")).length;
  if (wildcardRules * path.length > DECISION_BUDGET) return undefined;
  const matches = rules
    .filter(({ rule }) => ruleMatches(path, rule))
    .sort((a, b) => b.rule.length - a.rule.length);
  const [closest] = matches;
  if (!closest) return true;
  const longest = closest.rule.length;
  return matches.filter(({ rule }) => rule.length === longest).some(({ allow }) => allow);
};

const PROVIDERS: ReadonlyArray<readonly [string, string[]]> = [
  ["openai", ["gptbot", "oai-searchbot", "chatgpt-user"]],
  ["anthropic", ["claudebot", "claude-user"]],
  ["perplexity", ["perplexitybot"]],
  ["google", ["google-extended"]],
];

export const explicitAiPolicies = (parsed: RobotsParseResult): Record<string, string[]> => {
  const output: Record<string, string[]> = {};
  const tokens = new Set(
    parsed.groups.flatMap((group) => group.agents.map((agent) => agent.replace(/\/[\d.]+$/, ""))),
  );
  for (const [provider, agents] of PROVIDERS) {
    const found = agents.filter((agent) => tokens.has(agent));
    if (found.length) output[provider] = found;
  }
  return output;
};
