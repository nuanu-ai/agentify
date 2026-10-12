import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

// withMermaid wraps the whole config rather than adding a markdown plugin
// because the diagrams are drawn in the reader's browser: the wrapper registers
// the component that renders ```mermaid fences.
export default withMermaid(
  defineConfig({
    lang: "en",
    title: "Agentify",
    // The rest of the origin is light only; a dark portal would not match it.
    appearance: false,
    description:
      "Selling to AI agents with Agentify: connecting, cards, money and what can go wrong.",
    head: [
      ["link", { rel: "icon", href: "/assets/agentify-mark-heavy.svg", type: "image/svg+xml" }],
      ["meta", { property: "og:title", content: "Agentify commerce documentation" }],
      [
        "meta",
        {
          property: "og:description",
          content:
            "Connect your shop, publish product cards and fulfil paid orders from AI agents.",
        },
      ],
      ["meta", { name: "twitter:card", content: "summary" }],
      ["meta", { name: "twitter:title", content: "Agentify commerce documentation" }],
    ],
    cleanUrls: true,
    srcExclude: ["WRITING.md"],
    themeConfig: {
      // Not "Agentify": the theme already puts an "Agentify" link to the site
      // right before it.
      siteTitle: "Docs",
      sidebar: [
        {
          text: "For the owner",
          items: [
            { text: "Connecting to Agentify", link: "/" },
            { text: "Money", link: "/money" },
            { text: "Common questions", link: "/faq" },
          ],
        },
        {
          text: "For the engineer",
          items: [
            { text: "The first test sale", link: "/quickstart" },
            { text: "The product card", link: "/cards" },
            { text: "Orders and fulfillment modes", link: "/orders" },
            { text: "What can go wrong", link: "/failures" },
            { text: "Questions from the engineer", link: "/faq#questions-from-the-engineer" },
          ],
        },
      ],
      search: { provider: "local" },
    },

    /**
     * Writes the surface marker into every built page, and strips mermaid's
     * preloads from pages without a diagram. Mermaid is registered site-wide, so
     * otherwise every page preloads over a megabyte of diagram code that
     * `build.modulePreload` cannot reach. The filter keeps an allowlist rather
     * than removing known mermaid chunks: dropping an unneeded preload only
     * costs a lazy fetch, while missing a new mermaid chunk would cost every page.
     */
    transformHtml(code) {
      // Above the application root, not before </body>, where it would render
      // below the whole page and nobody would see it.
      if (!code.includes('<div id="app"')) {
        throw new Error(
          'the portal build no longer writes <div id="app">, so the surface marker has nowhere ' +
            "to go; find the new application root before shipping a site that says nothing about " +
            "which stack it is",
        );
      }
      const marked = code.replace('<div id="app"', `${SURFACE_MARKER}<div id="app"`);

      if (marked.includes('class="mermaid"')) return marked;

      return marked.replace(/[ \t]*<link rel="modulepreload" href="([^"]+)">\n?/g, (link, href) =>
        KEPT_CHUNK.test(href) ? link : "",
      );
    },
  }),
);

/** The framework, the theme and the page's own module. */
const KEPT_CHUNK = /\/(framework|theme)\.[^/]+\.js$|\.md\.[^/]+\.js$/;

/**
 * What every built page says about the stack serving it; Caddy fills in the
 * templates at request time. Written out rather than imported because this site
 * has no workspace dependencies; a test in packages/core holds these strings
 * against the dashboard's.
 */
const SURFACE_MARKER = [
  // Style .surface-words, never this div: on a live page the div must stay an
  // invisible marker, not an empty box.
  '<div data-agentify-surface="<!--{{env `AGENTIFY_SURFACE_MODE`}}-->">',
  '<!--{{if eq (env "AGENTIFY_SURFACE_MODE") "test"}}-->',
  '<p class="surface-words">Test environment. Payments settle on Base Sepolia with test funds, and every order and receipt here is marked as a test. The live site is agentify.ad.</p>',
  '<!--{{else if eq (env "AGENTIFY_SURFACE_MODE") "sandbox"}}-->',
  '<p class="surface-words">Sandbox. No chain stands behind this stack: every payment it accepts is pretend, nothing arrives at the address in a challenge, and no receipt it writes points at a transfer.</p>',
  "<!--{{end}}-->",
  "</div>",
].join("");
