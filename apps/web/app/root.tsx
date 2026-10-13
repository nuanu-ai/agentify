/**
 * The document every page is drawn in, and the page drawn when one cannot be.
 *
 * The root's loader reads the site's public settings and the browser's
 * analytics destinations from the environment, so the browser draws with the
 * values the server drew with; they do not change while the process runs. The
 * consent banner and the consented analytics are drawn on every page, the one
 * that says there is no such page included.
 */

import "@fontsource-variable/schibsted-grotesk/wght.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@agentify/visual/tokens.css";
import "./globals.css";

import { OnItsWay } from "@agentify/ui";
import type { ReactNode } from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  type MetaArgs,
  type MiddlewareFunction,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteError,
  useRouteLoaderData,
} from "react-router";
import { AnalyticsRuntime } from "../components/analytics-runtime";
import { ConsentBanner } from "../components/consent-banner";
import { NotFoundPage } from "../components/not-found-page";
import { PublicConfigProvider } from "../components/public-config";
import { SystemMessagePage } from "../components/system-message-page";
import { getPublicAppConfig } from "../lib/app-config";
import { DISPLAY_BRAND } from "../lib/brand";
import { pageMeta, siteTitle } from "../lib/page-meta";
import { markdownAnswer, withPlaceHeaders } from "../lib/server/answer-headers";
import { getBrowserAnalyticsConfig } from "../lib/server/browser-analytics-config";

export const links = () => [
  { rel: "manifest", href: "/manifest.webmanifest" },
  { rel: "icon", href: "/icon.svg", sizes: "any", type: "image/svg+xml" },
  { rel: "apple-touch-icon", href: "/apple-icon", type: "image/png", sizes: "180x180" },
];

/** Every answer a route gives, a page, its data or an API's, passes here. */
export const middleware: MiddlewareFunction<Response>[] = [
  async ({ request }, next) => markdownAnswer(request) ?? withPlaceHeaders(request, await next()),
];

export const loader = () => ({
  app: getPublicAppConfig(),
  analytics: getBrowserAnalyticsConfig(),
});

export const shouldRevalidate = () => false;

/**
 * The head of a page drawn in place of one that failed. Where the root's own
 * loader did not run, a refused request or a failure in it, there are no
 * settings to build the rest of the head from.
 */
export const meta = ({ loaderData, error }: MetaArgs<typeof loader>) =>
  loaderData === undefined
    ? [{ title: siteTitle(DISPLAY_BRAND) }]
    : pageMeta(loaderData.app, {
        robots: isRouteErrorResponse(error) && error.status === 404 ? "noindex" : undefined,
      });

/**
 * What every page's body carries around the page: the site's settings for the
 * components under it, the bar that says the next page is on its way, the
 * consented analytics and the consent banner. Where the root's own loader did
 * not run, there are no settings and the page is drawn alone.
 */
export function SiteBody({ children }: Readonly<{ children: ReactNode }>) {
  const site = useRouteLoaderData<typeof loader>("root");
  return site === undefined ? (
    children
  ) : (
    <PublicConfigProvider config={site.app}>
      <OnItsWay />
      {children}
      <AnalyticsRuntime config={site.analytics} />
      <ConsentBanner />
    </PublicConfigProvider>
  );
}

export function Layout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en-US">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <SiteBody>{children}</SiteBody>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/**
 * A page that cannot be found, wherever a loader said so, is the site's page
 * for that. A request the page does not take, such as a form posted to a page
 * that takes none, is told so; anything else that failed says so without
 * saying what, and the process's log has the line.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />;
  if (isRouteErrorResponse(error) && error.status < 500) {
    return (
      <SystemMessagePage
        actionLabel="Start a scan"
        description="This page takes no request of that kind. Open it to read it."
        title="This page cannot do that"
      />
    );
  }
  return (
    <SystemMessagePage
      actionLabel="Start a scan"
      description="Something on our side failed while drawing this page. Try again in a moment."
      title="Something went wrong"
    />
  );
}
