import { useHref, useNavigation } from "react-router";

/**
 * Where the browser is going inside the application, or null while it stays
 * put. A section or a filter is marked from this as soon as it is clicked,
 * before the next page has arrived. React Router holds that address with the
 * dashboard's prefix on it, and the pages name their addresses without it, so
 * the prefix is taken off.
 */
export function useGoingTo(): Readonly<{ pathname: string; search: string }> | null {
  const navigation = useNavigation();
  const base = useHref("/");
  if (navigation.state !== "loading") return null;
  const { pathname, search } = navigation.location;
  const prefix = base.endsWith("/") ? base.slice(0, -1) : base;
  const inside =
    prefix !== "" && (pathname === prefix || pathname.startsWith(`${prefix}/`))
      ? pathname.slice(prefix.length) || "/"
      : pathname;
  return { pathname: inside, search };
}
