import { useEffect, useState } from "react";
import { useLocation, useRevalidator } from "react-router";
import type { ShopJobView } from "../../src/shop-job-view.js";

/** Progress reads stay local; a newly terminal publication refreshes its parent once. */
export function useShopJob(initial: ShopJobView | null, endpoint: string) {
  const [view, setView] = useState(initial);
  const [unread, setUnread] = useState(false);
  const location = useLocation();
  const { revalidate } = useRevalidator();
  useEffect(() => {
    setView(initial);
    let previous = initial;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const read = async () => {
      let again = true;
      try {
        const response = await fetch(endpoint + location.search, {
          signal: controller.signal,
          credentials: "same-origin",
        });
        if (!response.ok) throw new Error("unread");
        const next: ShopJobView | null = await response.json();
        again = next === null || next.status === "queued" || next.status === "running";
        if (!cancelled) {
          setView(next);
          setUnread(false);
          if (
            next?.kind === "publish" &&
            !again &&
            (previous?.id !== next.id ||
              previous.status === "queued" ||
              previous.status === "running")
          )
            void revalidate();
          previous = next;
        }
      } catch {
        if (!cancelled) setUnread(true);
      }
      if (!cancelled) timer = setTimeout(read, again ? 1000 : 5000);
    };
    void read();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [initial, endpoint, location.search, revalidate]);
  return [view, unread] as const;
}
