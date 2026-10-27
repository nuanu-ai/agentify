import { getPublicAppConfig } from "./app-config";

const PRIVATE_ROBOTS_PATHS = [
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

export function buildRobotsPolicy(): string {
  const { baseUrl } = getPublicAppConfig();
  const publicRules = privateRules();
  return [
    ...agentGroup(["*"], publicRules),
    "",
    ...agentGroup(allowedAgentTokens, publicRules),
    "",
    ...agentGroup(["GPTBot", "Google-Extended"], ["Disallow: /"]),
    "",
    "Content-Signal: search=yes, ai-input=yes, ai-train=no",
    `Sitemap: ${new URL("/sitemap.xml", baseUrl).toString()}`,
    "",
  ].join("\n");
}
