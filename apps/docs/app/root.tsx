/**
 * The document every page of the documentation is drawn in: the site header
 * every surface draws, whose menu lists the documentation's pages where the
 * page has no room for its contents, the part Caddy fills under it, the page
 * and the site's foot, with the consent banner every measured page of the
 * origin carries and the page views a visitor's choice allows.
 *
 * The root's data never changes, yet it carries no `shouldRevalidate`: a
 * route that opts out of revalidation makes React Router prefetch a page's
 * data under an address with `?_routes=`, while a prerendered site's
 * navigation asks for the address without it, and the prefetch is wasted.
 */

// The faces are written into the page's one stylesheet rather than linked
// apart: a second stylesheet holds the first paint for a round trip of its own.
import "@agentify/visual/public/styles/fonts.css";
import "@agentify/visual/tokens.css";
import "@agentify/visual/editorial.css";
import "@agentify/visual/consent.css";
import "./docs.css";

import { ConsentBanner, KeptChoiceScript, PrivacyChoicesButton } from "@agentify/consent";
import { Footer, SiteHeader, SiteMenu } from "@agentify/ui";
import { type ReactNode, useMemo, useState } from "react";
import {
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLocation,
  useRouteError,
  useRouteLoaderData,
} from "react-router";
import { Contents } from "./components/contents.js";
import { Measured } from "./components/measured.js";
import { Missing, Unavailable } from "./components/missing.js";
import { SERVED_CLASS, servedPart, servedTemplate } from "./served.js";

export const links = () => [
  {
    rel: "preload",
    href: "/styles/fonts/schibsted-grotesk-latin-wght-normal.woff2",
    as: "font",
    type: "font/woff2",
    crossOrigin: "anonymous",
  },
  { rel: "icon", href: "/assets/agentify-mark-heavy.svg", type: "image/svg+xml" },
];

export const meta = () => [{ title: "Agentify documentation" }];

export const loader = () => ({ served: servedTemplate() });

/** The part Caddy filled, drawn as it was served and never drawn over. */
function Served({ built }: Readonly<{ built: string }>) {
  const [served] = useState(() => servedPart(built));
  const inner = useMemo(() => ({ __html: served }), [served]);
  return (
    <div
      className={SERVED_CLASS}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: Caddy's templates, filled when the file is served
      dangerouslySetInnerHTML={inner}
      suppressHydrationWarning
    />
  );
}

/** How the header links to a page of the documentation: followed in place, fetched on a rest. */
function OwnLink({
  to,
  className,
  children,
  "aria-current": current,
}: Readonly<{ to: string; className?: string; "aria-current"?: "true"; children: ReactNode }>) {
  return (
    <Link to={to} className={className} aria-current={current} prefetch="intent">
      {children}
    </Link>
  );
}

/** The documentation's pages in the header's menu, for a page with no room for its contents. */
function MenuContents() {
  // The prerender asks for a page with a trailing slash, the browser without.
  const current = useLocation().pathname.replace(/(.)\/+$/, "$1");
  return (
    <div className="docs-menu">
      <Contents current={current} label="Documentation pages" />
    </div>
  );
}

const FOOT_LINKS = [
  { href: "/docs/", label: "Documentation" },
  { href: "/docs/scanner", label: "Scanner" },
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
];

/** What every page's body carries around the page: the header, the part Caddy fills and the foot. */
export function DocsBody({ children }: Readonly<{ children: ReactNode }>) {
  const site = useRouteLoaderData<typeof loader>("root");
  return (
    <>
      <SiteHeader
        surface="docs"
        link={OwnLink}
        menu={<SiteMenu surface="docs" link={OwnLink} contents={<MenuContents />} />}
      />
      {site === undefined ? null : <Served built={site.served} />}
      {children}
      <Footer links={FOOT_LINKS}>
        <PrivacyChoicesButton className="foot-action" />
      </Footer>
      <ConsentBanner brand="Agentify" />
      {site === undefined ? null : <Measured built={site.served} />}
    </>
  );
}

export function Layout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        <KeptChoiceScript />
      </head>
      <body>
        <DocsBody>{children}</DocsBody>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/** A page the documentation does not have says so; any other failure says it is not known what is there. */
export function ErrorBoundary() {
  const error = useRouteError();
  return isRouteErrorResponse(error) && error.status === 404 ? <Missing /> : <Unavailable />;
}
