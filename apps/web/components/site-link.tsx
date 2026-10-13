import { Link, type LinkProps, useNavigation, useResolvedPath } from "react-router";

import { PUBLIC_PAGE_PATHS } from "../content/public-page-metadata";

/**
 * A link to a page of the scanner, followed without a page load. A link to a
 * public page, whose data a browser may keep, is fetched while the pointer
 * rests on it; a link to anything else is fetched only once clicked, since a
 * scan or a report is never fetched for a visitor who did not ask for it. From
 * the click until the next page is drawn the link is marked `data-going`, so
 * the click shows at once even where the page takes a while.
 *
 * A page another process serves on this origin, the documentation or the
 * dashboard, is a plain anchor rather than this: the router would look for it
 * among the scanner's own pages and draw the page that says there is none.
 */
export function SiteLink({
  to,
  ...props
}: Readonly<Omit<LinkProps, "to" | "prefetch"> & { to: string }>) {
  const navigation = useNavigation();
  const target = useResolvedPath(to);
  const going = navigation.state === "loading" && navigation.location.pathname === target.pathname;
  const keeps = (PUBLIC_PAGE_PATHS as readonly string[]).includes(target.pathname);
  return (
    <Link
      {...props}
      data-going={going ? "" : undefined}
      prefetch={keeps ? "intent" : "none"}
      to={to}
    />
  );
}
