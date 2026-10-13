import { type ComponentType, lazy } from "react";

const RELOADED = "agentify:reloaded-for-a-part";

/**
 * A part of a page whose script is fetched when the part is first drawn. A
 * part that cannot be fetched in the browser, such as one a newer deployment
 * replaced while the page stood open, reloads the page once, as React Router
 * does for a page's own module, rather than replacing the page with the one
 * that says something failed. The reload is remembered for the address for the
 * tab's life: a part that still cannot be fetched after it fails as any
 * failure does, since the reloaded page would only draw the part again.
 */
export function lazyPart<Props extends object>(load: () => Promise<ComponentType<Props>>) {
  return lazy(async () => {
    try {
      return { default: await load() };
    } catch (error) {
      if (typeof window === "undefined" || !markedReload(window.location.pathname)) throw error;
      window.location.reload();
      return new Promise<never>(() => {});
    }
  });
}

/** Marks a reload for this address and says whether it may happen: once, where storage works. */
function markedReload(path: string): boolean {
  try {
    const reloaded: unknown = JSON.parse(window.sessionStorage.getItem(RELOADED) ?? "[]");
    const paths = Array.isArray(reloaded) ? reloaded : [];
    if (paths.includes(path)) return false;
    window.sessionStorage.setItem(RELOADED, JSON.stringify([...paths, path]));
    return true;
  } catch {
    return false;
  }
}
