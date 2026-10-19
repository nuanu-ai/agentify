/**
 * The documentation's pages, in the groups its contents list them in. The
 * documentation draws its contents from this list, the scanner names the
 * pages to language models from it, and the site header leads into the
 * scanner's section by it, so a page added here reaches all three.
 *
 * A path is the page's address inside the documentation, which is served at
 * `/docs`; `section` makes an entry a link to a part of a page rather than a
 * page of its own.
 */

export type DocsEntry = Readonly<{ label: string; path: string; section?: string }>;

export type DocsGroup = Readonly<{ label: string; entries: readonly DocsEntry[] }>;

export const DOCS_GROUPS: readonly DocsGroup[] = [
  {
    label: "For the owner",
    entries: [
      { label: "Connecting to Agentify", path: "/" },
      { label: "Money", path: "/money" },
      { label: "Sending a payout", path: "/payout" },
      { label: "Selling through WooCommerce", path: "/woocommerce" },
      { label: "Common questions", path: "/faq" },
    ],
  },
  {
    label: "For the engineer",
    entries: [
      { label: "The first test sale", path: "/quickstart" },
      { label: "The product card", path: "/cards" },
      { label: "Orders and fulfillment modes", path: "/orders" },
      { label: "What can go wrong", path: "/failures" },
      {
        label: "Questions from the engineer",
        path: "/faq",
        section: "questions-from-the-engineer",
      },
    ],
  },
  {
    label: "Scanner",
    entries: [
      { label: "About agentify-scanner", path: "/scanner" },
      { label: "Methodology", path: "/scanner/methodology" },
    ],
  },
];

/** Every page once, in the order the contents list them, which is the order of "previous" and "next". */
export const DOCS_PAGES: readonly DocsEntry[] = DOCS_GROUPS.flatMap((group) =>
  group.entries.filter((entry) => entry.section === undefined),
);

/** A page's whole address on the origin: `/money` is `/docs/money`, the front page `/docs/`. */
export const docsAddress = (path: string): string => `/docs${path === "/" ? "/" : path}`;
