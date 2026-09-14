import { getPublicAppConfig } from "./app-config";

export const PRIVATE_ROBOTS_PATHS = [
  "/admin",
  "/api/",
  "/scan/",
  "/report/",
  "/s/",
  "/auth/",
  "/email/",
  "/verification/",
  "/data-request",
] as const;

export type ContentUsePolicy = Readonly<{
  search: "yes" | "no";
  aiInput: "yes" | "no";
  aiTrain: "yes" | "no";
}>;

export const PRODUCTION_CONTENT_USE_POLICY = {
  search: "yes",
  aiInput: "yes",
  aiTrain: "no",
} as const satisfies ContentUsePolicy;

const allowedAgentTokens = [
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-User",
  "PerplexityBot",
] as const;

const privateRules = (): string[] => [
  "Allow: /",
  ...PRIVATE_ROBOTS_PATHS.map((path) => `Disallow: ${path}`),
];

const agentGroup = (agents: readonly string[], rules: readonly string[]) => [
  ...agents.map((agent) => `User-agent: ${agent}`),
  ...rules,
];

export function buildRobotsPolicy(
  policy: ContentUsePolicy = PRODUCTION_CONTENT_USE_POLICY,
): string {
  const { baseUrl } = getPublicAppConfig();
  const publicRules = privateRules();
  const trainingRules =
    policy.aiTrain === "yes" ? publicRules : ["Disallow: /"];

  return [
    ...agentGroup(["*"], publicRules),
    "",
    ...agentGroup(allowedAgentTokens, publicRules),
    "",
    ...agentGroup(["GPTBot", "Google-Extended"], trainingRules),
    "",
    `Content-Signal: search=${policy.search}, ai-input=${policy.aiInput}, ai-train=${policy.aiTrain}`,
    `Sitemap: ${new URL("/sitemap.xml", baseUrl).toString()}`,
    "",
  ].join("\n");
}
