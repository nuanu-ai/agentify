import { type ComponentType, createElement, lazy, useEffect, useState } from "react";

const RELOADED = "agentify:reloaded-for-a-part";

/**
 * A part of a page whose script is fetched when the part is first drawn, or
 * earlier by `preload`, where the page knows it will be wanted soon; a part
 * whose script is already here when it is first drawn is drawn at once, with
 * no fallback in between. A part that cannot be fetched in the browser, such
 * as one a newer deployment replaced while the page stood open, reloads the
 * page once, as React Router does for a page's own module, rather than
 * replacing the page with the one that says something failed. The reload is
 * remembered for the address for the tab's life: a part that still cannot be
 * fetched after it fails as any failure does, since the reloaded page would
 * only draw the part again. A preload that fails says nothing; drawing the
 * part asks again.
 */
export function lazyPart<Props extends object>(
  load: () => Promise<ComponentType<Props>>,
): ComponentType<Props> & Fetchable {
  let loaded: ComponentType<Props> | null = null;
  let loading: Promise<ComponentType<Props>> | null = null;
  const loadOnce = () => {
    loading ??= load().then(
      (component) => {
        loaded = component;
        return component;
      },
      (error: unknown) => {
        loading = null;
        throw error;
      },
    );
    return loading;
  };
  const Fetched = lazy(async () => {
    try {
      return { default: await loadOnce() };
    } catch (error) {
      if (typeof window === "undefined" || !markedReload(window.location.pathname)) throw error;
      window.location.reload();
      return new Promise<never>(() => {});
    }
  });
  // Chosen once for the life of the part where it is drawn: a part that
  // switched from one to the other would be drawn anew and lose what it held.
  function Part(props: Props) {
    const [Drawn] = useState<ComponentType<Props>>(() => loaded ?? Fetched);
    return createElement(Drawn, props);
  }
  return Object.assign(Part, {
    isHere: () => loaded !== null,
    preload: () =>
      loadOnce().then(
        () => {},
        () => {},
      ),
  });
}

/** What a page asks of a part before it draws it. */
type Fetchable = Readonly<{
  /** Whether the part's script is here, so it is drawn with no fallback. */
  isHere: () => boolean;
  /** Fetches the part's script, settling once it is here or has failed. */
  preload: () => Promise<void>;
}>;

/**
 * Whether `part` can be drawn now with no fallback, its script fetched while
 * it is `wanted`. A fetch that failed counts as done, so the part is drawn and
 * asks for its script again, as a part that cannot be fetched does.
 */
export function useHere(part: Fetchable, wanted: boolean): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!wanted || settled || part.isHere()) return;
    let current = true;
    void part.preload().then(() => {
      if (current) setSettled(true);
    });
    return () => {
      current = false;
    };
  }, [part, settled, wanted]);
  return settled || part.isHere();
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
