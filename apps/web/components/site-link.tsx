import { type SyntheticEvent, useContext, useState } from "react";
import {
  UNSAFE_DataRouterContext as DataRouterContext,
  UNSAFE_FrameworkContext as FrameworkContext,
  Link,
  type LinkProps,
  matchRoutes,
  useNavigation,
  useResolvedPath,
} from "react-router";

import { PUBLIC_PAGE_PATHS } from "../content/public-page-metadata";

/**
 * A link to a page of the scanner, followed without a page load. A link to a
 * public page, whose data a browser may keep, is fetched while the pointer
 * rests on it, stylesheets included; a link to anything else is fetched only
 * once clicked, since a scan or a report is never fetched for a visitor who did
 * not ask for it. From the click until the next page is drawn the link is
 * marked `data-going`, so the click shows at once even where the page takes a
 * while.
 *
 * A page another process serves on this origin, the documentation or the
 * dashboard, is a plain anchor rather than this: the router would look for it
 * among the scanner's own pages and draw the page that says there is none.
 */
export function SiteLink({
  to,
  onFocus,
  onMouseEnter,
  onTouchStart,
  ...props
}: Readonly<Omit<LinkProps, "to" | "prefetch"> & { to: string }>) {
  const navigation = useNavigation();
  const target = useResolvedPath(to);
  const going = navigation.state === "loading" && navigation.location.pathname === target.pathname;
  const keeps = (PUBLIC_PAGE_PATHS as readonly string[]).includes(target.pathname);
  const stylesheetsOf = useStylesheets();
  const [ahead, setAhead] = useState<readonly string[] | null>(null);
  // React Router fetches the page's script and data ahead, but not its
  // stylesheets, and holds the click until they are here.
  const fetchAhead =
    <Event extends SyntheticEvent>(own?: (event: Event) => void) =>
    (event: Event) => {
      own?.(event);
      if (keeps && ahead === null) setAhead(stylesheetsOf(target.pathname));
    };
  return (
    <>
      <Link
        {...props}
        data-going={going ? "" : undefined}
        prefetch={keeps ? "intent" : "none"}
        to={to}
        onFocus={fetchAhead(onFocus)}
        onMouseEnter={fetchAhead(onMouseEnter)}
        onTouchStart={fetchAhead(onTouchStart)}
      />
      {ahead?.map((href) => (
        <link key={href} rel="prefetch" as="style" href={href} />
      ))}
    </>
  );
}

/**
 * The stylesheets a page of the scanner is drawn with, as the build lists them
 * for the browser, less those the window already has. A page the browser has
 * not been told of yet has none.
 */
function useStylesheets(): (pathname: string) => readonly string[] {
  const framework = useContext(FrameworkContext);
  const router = useContext(DataRouterContext)?.router;
  return (pathname) => {
    if (framework === undefined || router === undefined) return [];
    const hrefs = (matchRoutes(router.routes, pathname) ?? []).flatMap(
      ({ route }) =>
        (route.id === undefined ? undefined : framework.manifest.routes[route.id]?.css) ?? [],
    );
    return [...new Set(hrefs)].filter(
      (href) => document.querySelector(`link[rel="stylesheet"][href="${href}"]`) === null,
    );
  };
}
