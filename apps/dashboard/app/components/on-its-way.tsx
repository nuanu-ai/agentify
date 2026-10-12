import { useEffect, useState } from "react";
import { useHref, useNavigation } from "react-router";

/** Long enough that a page arriving at once does not flash a bar. */
const AFTER_MS = 150;

/**
 * A thin bar over the top of the window while the next page is on its way and
 * has taken longer than a moment. It is fixed to the window, so showing it
 * moves nothing on the page.
 */
export function OnItsWay() {
  const going = useNavigation().state !== "idle";
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!going) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), AFTER_MS);
    return () => clearTimeout(timer);
  }, [going]);
  return <div className="on-its-way" role="progressbar" aria-label="Loading" hidden={!shown} />;
}

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
