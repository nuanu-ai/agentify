/**
 * One page of the documentation, drawn from the Markdown its address names in
 * `pages.ts`: the page's group over its heading, the pages before and after it
 * at its foot, and for a page that was the scanner's, the site's description
 * for a crawler. Its loader runs only while the build prerenders the pages.
 */

import { DOCS_GROUPS } from "@agentify/ui/docs";
import { type MouseEvent, useMemo } from "react";
import {
  data,
  Link,
  type LoaderFunctionArgs,
  type MetaArgs,
  useLoaderData,
  useNavigate,
  useRouteLoaderData,
} from "react-router";
import { Missing } from "../components/missing.js";
import { Reading } from "../components/reading.js";
import { headOf, structuredDataOf } from "../head.js";
import { renderedPages } from "../markdown.server.js";
import { DOCS_DESCRIPTION, NOT_FOUND_PATH, PAGES } from "../pages.js";
import type { loader as rootLoader } from "../root.js";
import { servedValues } from "../served.js";
import { fillSiteValues } from "../site-values.js";

const groupOf = (path: string): string =>
  DOCS_GROUPS.find((group) => group.entries.some((entry) => entry.path === path))?.label ?? "";

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const path = `/${params["*"] ?? ""}`.replace(/(.)\/+$/, "$1");
  if (path === NOT_FOUND_PATH) return { kind: "missing" as const };
  const at = PAGES.findIndex((each) => each.path === path);
  const source = PAGES[at];
  const page = (await renderedPages()).get(path);
  if (source === undefined || page === undefined) throw data(null, { status: 404 });
  const neighbour = (other: (typeof PAGES)[number] | undefined) =>
    other === undefined ? null : { to: other.path, title: other.label };
  return {
    kind: "page" as const,
    path,
    group: groupOf(path),
    title: source.title ?? page.title,
    description: source.description ?? DOCS_DESCRIPTION,
    site: source.site === true,
    html: page.html,
    sections: page.headings
      .filter((heading) => heading.level === 2)
      .map(({ id, title }) => ({ id, title })),
    previous: neighbour(PAGES[at - 1]),
    next: neighbour(PAGES[at + 1]),
  };
};

const builtOf = (matches: MetaArgs["matches"]): string =>
  (matches.find((match) => match?.id === "root")?.loaderData as { served?: string } | undefined)
    ?.served ?? "";

export const meta = ({ loaderData, matches }: MetaArgs<typeof loader>) =>
  loaderData?.kind === "page"
    ? headOf(loaderData, builtOf(matches))
    : [{ title: "No such page · Agentify" }, { name: "robots", content: "noindex" }];

/**
 * A press inside the page's text: a copy button copies its block, and a link
 * to another page of the documentation is followed in place, as the contents'
 * links are. A link opened apart, with a modifier or to anywhere else loads
 * as any link does.
 */
function usePressesInside() {
  const navigate = useNavigate();
  return (event: MouseEvent<HTMLElement>) => {
    if (!(event.target instanceof Element)) return;
    const copy = event.target.closest("button.copy");
    if (copy !== null) {
      void navigator.clipboard.writeText(
        copy.parentElement?.querySelector("pre")?.textContent ?? "",
      );
      copy.classList.add("copied");
      setTimeout(() => copy.classList.remove("copied"), 2000);
      return;
    }
    const link = event.target.closest("a");
    const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
    if (link === null || modified || event.button !== 0 || link.target !== "") return;
    if (link.origin !== window.location.origin || !/^\/docs(\/|$)/.test(link.pathname)) return;
    if (link.pathname === window.location.pathname && link.hash !== "") return;
    event.preventDefault();
    navigate(`${link.pathname.replace(/^\/docs/, "") || "/"}${link.search}${link.hash}`);
  };
}

export default function DocPage() {
  const page = useLoaderData<typeof loader>();
  const built = useRouteLoaderData<typeof rootLoader>("root")?.served ?? "";
  const pressInside = usePressesInside();
  const values = servedValues(built);
  const html = page.kind === "page" ? page.html : "";
  const filled = values === null ? html : fillSiteValues(html, values);
  // React writes raw HTML again whenever it is handed a new object, so one per text.
  const inner = useMemo(() => ({ __html: filled }), [filled]);
  const site = page.kind === "page" && page.site;
  const structured = useMemo(
    () => ({ __html: site ? structuredDataOf(built) : "" }),
    [site, built],
  );
  if (page.kind === "missing") return <Missing />;
  return (
    <Reading current={page.path} sections={page.sections}>
      {page.site ? (
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON with every `<` escaped but where Caddy's templates open
          dangerouslySetInnerHTML={structured}
        />
      ) : null}
      <div className="eyebrow">{page.group}</div>
      <div
        className="doc"
        onClick={pressInside}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: the page's own Markdown, rendered at build time
        dangerouslySetInnerHTML={inner}
      />
      <nav className="docs-turn" aria-label="Previous and next page">
        {page.previous === null ? (
          <span />
        ) : (
          <Link to={page.previous.to} rel="prev" prefetch="intent">
            <span>Previous page</span>
            {page.previous.title}
          </Link>
        )}
        {page.next === null ? null : (
          <Link to={page.next.to} rel="next" prefetch="intent">
            <span>Next page</span>
            {page.next.title}
          </Link>
        )}
      </nav>
    </Reading>
  );
}
