import { AGENTIC_SHOP, numbered } from "../content/agentic-shop";
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
import type { KeptPagePath } from "../content/public-page-metadata";
import { getPublicAppConfig } from "./app-config";

function absoluteHref(href: string, baseUrl: string): string {
  return href.startsWith("/") ? new URL(href, baseUrl).toString() : href;
}

function nodeToMarkdown(node: Exclude<RichText, string>[number], baseUrl: string): string {
  switch (node.kind) {
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

/** The line that leads an agent sent to buy to where it starts. */
function agentDoor(baseUrl: string): string {
  const { lead, label, href, rest } = LANDING_SHARED_CONTENT.agentDoor;
  return `${lead} [${label}](${new URL(href, baseUrl).toString()})${rest}`;
}

function renderLanding(config: LandingConfig): string {
  const app = getPublicAppConfig();
  const output = [
    `# ${config.hero.title}`,
    "",
    config.hero.subtitle,
    "",
    ...LANDING_SHARED_CONTENT.assurances.map((item) => `- ${item}`),
    "",
    `${config.secondDoor.lead} [${config.secondDoor.label}](${new URL(config.secondDoor.href, app.baseUrl).toString()})`,
    "",
    agentDoor(app.baseUrl),
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
    `[${LANDING_SHARED_CONTENT.reportMethodologyLink}](${new URL("/docs/scanner/methodology", app.baseUrl).toString()})`,
    "",
  );
  for (const check of LANDING_EXAMPLE_CHECKS) output.push(`- ${check.name} — ${check.status}`);

  output.push("", `## ${LANDING_SHARED_CONTENT.finalCta}`, "");
  return output.join("\n");
}

/** The page about selling to agents, from the words the page draws. */
function renderAgenticShop(): string {
  const { baseUrl } = getPublicAppConfig();
  const whole = (href: string): string => absoluteHref(href, baseUrl);
  const words = (content: RichText): string => richTextToMarkdown(content, baseUrl);
  const { hero, promise, opportunity, how, payment, loyalty, businesses, start, questions } =
    AGENTIC_SHOP;
  const { research } = opportunity;
  const signIn = whole("/dashboard/sign-in");
  return [
    `# ${hero.title.join(" ")}`,
    "",
    hero.description,
    "",
    `[${hero.action}](${signIn})`,
    "",
    words(hero.note),
    "",
    agentDoor(baseUrl),
    "",
    `${promise.lead} ${promise.strong} ${promise.items.join(" · ")}.`,
    "",
    `## ${opportunity.title.join(" ")}`,
    "",
    opportunity.text,
    "",
    `- +${research.traffic.growthPercent}%: ${opportunity.growth.join(" ")} (${opportunity.chartHeading.join(", ")}). ${opportunity.sourceScope}`,
    `- +${research.conversion.relativeLiftPercent}%: ${opportunity.conversion} ${opportunity.conversionScope}`,
    "",
    `Source: [${opportunity.source}](${research.sourceUrl}).`,
    "",
    `## ${how.title.join(" ")}`,
    "",
    how.lede,
    "",
    ...how.steps.flatMap((step, index) => [
      `### ${numbered(index)} · ${step.title}`,
      "",
      words(step.text),
      "",
    ]),
    `## ${payment.title.join(" ")}`,
    "",
    payment.text,
    "",
    ...payment.path.steps.map(([title, text], index) => `${index + 1}. ${title}: ${text}`),
    "",
    `[${payment.more.label}](${whole(payment.more.href)})`,
    "",
    loyalty,
    "",
    `## ${businesses.title.join(" ")}`,
    "",
    businesses.lede,
    "",
    ...businesses.categories.map(
      (category) => `- ${category.title}: ${category.text} (${category.examples})`,
    ),
    "",
    `## ${start.title.join(" ")}`,
    "",
    start.text,
    "",
    ...start.steps.map((step) => `- ${words(step)}`),
    "",
    `### ${start.card.title}`,
    "",
    `${start.card.text} [${start.card.action}](${signIn})`,
    "",
    start.card.footnote,
    "",
    `## ${questions.title}`,
    "",
    words(questions.text),
    "",
  ].join("\n");
}

export function getPublicPageMarkdown(path: KeptPagePath): string {
  switch (path) {
    case "/":
      return renderLanding(LANDINGS.owner);
    case "/store":
      return renderLanding(LANDINGS.store);
    case "/local":
      return renderLanding(LANDINGS.local);
    case "/privacy":
    case "/terms":
      return renderEditorial(path);
    case "/agentic-shop":
      return renderAgenticShop();
  }
}
