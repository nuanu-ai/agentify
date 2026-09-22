import {
  LANDING_EXAMPLE_CHECKS,
  LANDING_SHARED_CONTENT,
  LANDINGS,
  type LandingConfig,
} from "../content/landing";
import {
  getPublicEditorialPage,
  type PublicEditorialPath,
  type RichText,
} from "../content/public-editorial";
import { PUBLIC_PAGE_PATHS, type PublicPagePath } from "../content/public-page-metadata";
import { getPublicAppConfig } from "./app-config";

export const PUBLIC_MARKDOWN_PATHS = PUBLIC_PAGE_PATHS;

function absoluteHref(href: string, baseUrl: string): string {
  return href.startsWith("/") ? new URL(href, baseUrl).toString() : href;
}

function nodeToMarkdown(node: Exclude<RichText, string>[number], baseUrl: string): string {
  switch (node.kind) {
    case "code":
      return `\`${node.value.replaceAll("`", "\\`")}\``;
    case "strong":
      return `**${node.value}**`;
    case "link":
      return `[${node.value}](${absoluteHref(node.href ?? "", baseUrl)})`;
    case "text":
      return node.value;
  }
}

function richTextToMarkdown(content: RichText, baseUrl: string): string {
  if (typeof content === "string") return content;
  return content.map((node) => nodeToMarkdown(node, baseUrl)).join("");
}

function renderEditorial(path: PublicEditorialPath): string {
  const config = getPublicAppConfig();
  const page = getPublicEditorialPage(path, config);
  const output = [`# ${page.title}`, "", page.intro, ""];

  for (const section of page.sections) {
    output.push(`## ${section.title}`, "");
    for (const block of section.blocks) {
      if (block.kind === "list") {
        for (const item of block.items)
          output.push(`- ${richTextToMarkdown(item, config.baseUrl)}`);
        output.push("");
      } else {
        const content = richTextToMarkdown(block.content, config.baseUrl);
        output.push(block.kind === "notice" ? `> ${content}` : content, "");
      }
    }
  }
  return output.join("\n");
}

function renderLanding(config: LandingConfig): string {
  const app = getPublicAppConfig();
  const output = [
    `# ${config.hero.title}`,
    "",
    config.hero.subtitle,
    "",
    ...LANDING_SHARED_CONTENT.assurances.map((item) => `- ${item}`),
    ...(config.secondDoor
      ? [
          "",
          `${config.secondDoor.lead} [${config.secondDoor.label}](${new URL(config.secondDoor.href, app.baseUrl).toString()})`,
        ]
      : []),
    "",
  ];

  output.push(`## ${LANDING_SHARED_CONTENT.howTitle}`, "");
  for (const step of LANDING_SHARED_CONTENT.howSteps)
    output.push(`### ${step.index} · ${step.title}`, "", step.body, "");

  output.push(
    `## ${LANDING_SHARED_CONTENT.reportTitle}`,
    "",
    `**${LANDING_SHARED_CONTENT.reportLabel} · ${LANDING_SHARED_CONTENT.reportHeading}**`,
    "",
    `[${LANDING_SHARED_CONTENT.reportMethodologyLink}](${new URL("/methodology", app.baseUrl).toString()})`,
    "",
  );
  for (const check of LANDING_EXAMPLE_CHECKS) output.push(`- ${check.name} — ${check.status}`);

  output.push("", `## ${LANDING_SHARED_CONTENT.finalCta}`, "");
  return output.join("\n");
}

export function getPublicPageMarkdown(path: PublicPagePath): string {
  switch (path) {
    case "/":
      return renderLanding(LANDINGS.owner);
    case "/store":
      return renderLanding(LANDINGS.store);
    case "/local":
      return renderLanding(LANDINGS.local);
    case "/methodology":
    case "/scanner":
    case "/privacy":
    case "/terms":
      return renderEditorial(path);
  }
}
