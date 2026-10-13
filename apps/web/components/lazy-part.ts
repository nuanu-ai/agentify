import { type ComponentType, lazy } from "react";

/**
 * A part of a page whose script is fetched when the part is first drawn. A
 * part that cannot be fetched in the browser, such as one a newer deployment
 * has replaced while the page stood open, reloads the page, as React Router
 * does for a page's own module, rather than replacing the page with the one
 * that says something failed.
 */
export function lazyPart<Props extends object>(load: () => Promise<ComponentType<Props>>) {
  return lazy(async () => {
    try {
      return { default: await load() };
    } catch (error) {
      if (typeof window === "undefined") throw error;
      window.location.reload();
      return new Promise<never>(() => {});
    }
  });
}
