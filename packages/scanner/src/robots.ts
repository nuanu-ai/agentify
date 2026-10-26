type RobotsGroup = {
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

// RFC 9309 matches a group by a crawler's product token, the leading run of
// letters, "_" and "-" of a user-agent value, without regard to case: what
// follows it, a version or a comment, does not count, and a part of the
// token names another crawler.
const productToken = (value: string): string =>
  /^\*(?:\s|$)/.test(value) ? "*" : (/^[a-z_-]*/i.exec(value)?.[0] ?? "").toLowerCase();

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
      if (!value) malformedDirectives += 1;
      else {
        const token = productToken(value);
        if (token) current.agents.push(token);
      }
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

// A rule with a wildcard is searched for along the whole path, piece by
// piece, so it costs up to the path's length plus its own; a rule without
// one only compares the path's start. Past this many characters for one
// decision it is not made.
const DECISION_BUDGET = 4 * 1024 * 1024;

// true or false for the path, or undefined when deciding would cost more
// than DECISION_BUDGET: "robots.txt could not be assessed", never a guess.
export const isPathAllowed = (
  parsed: RobotsParseResult,
  userAgent: string,
  path: string,
): boolean | undefined => {
  const token = productToken(userAgent);
  const named = parsed.groups.filter((group) => group.agents.includes(token));
  const groups = named.length ? named : parsed.groups.filter((group) => group.agents.includes("*"));
  const rules = groups.flatMap((group) => [
    ...group.allow.map((rule) => ({ rule, allow: true })),
    ...group.disallow.map((rule) => ({ rule, allow: false })),
  ]);
  let cost = 0;
  for (const { rule } of rules) if (rule.includes("*")) cost += path.length + rule.length;
  if (cost > DECISION_BUDGET) return undefined;
  // The longest matching rule decides, and between an Allow and a Disallow
  // of the same length, Allow.
  let longest = -1;
  let allowed = true;
  for (const { rule, allow } of rules) {
    if (rule.length < longest || !ruleMatches(path, rule)) continue;
    allowed = rule.length > longest ? allow : allowed || allow;
    longest = rule.length;
  }
  return allowed;
};

const PROVIDERS: ReadonlyArray<readonly [string, string[]]> = [
  ["openai", ["gptbot", "oai-searchbot", "chatgpt-user"]],
  ["anthropic", ["claudebot", "claude-user"]],
  ["perplexity", ["perplexitybot"]],
  ["google", ["google-extended"]],
];

/** The AI crawler groups robots.txt is expected to state a policy for. */
export const AI_PROVIDERS: readonly string[] = PROVIDERS.map(([provider]) => provider);

export const explicitAiPolicies = (parsed: RobotsParseResult): Record<string, string[]> => {
  const output: Record<string, string[]> = {};
  const tokens = new Set(parsed.groups.flatMap((group) => group.agents));
  for (const [provider, agents] of PROVIDERS) {
    const found = agents.filter((agent) => tokens.has(agent));
    if (found.length) output[provider] = found;
  }
  return output;
};
