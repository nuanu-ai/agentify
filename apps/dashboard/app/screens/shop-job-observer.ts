import { useEffect, useState } from "react";
import { useLocation, useRevalidator } from "react-router";
import type { ShopJobView } from "../../src/shop-job-view.js";

/**
 * Progress reads stay local while a job is queued or running; a newly terminal
 * job refreshes its parent once. After that only the latest job's id and
 * revision are asked for, so a job started elsewhere still reaches an open
 * page without its result being read again.
 */
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
    const asked = (search: string) =>
      fetch(endpoint + search, { signal: controller.signal, credentials: "same-origin" });
    const read = async () => {
      let again = true;
      try {
        const response = await asked(location.search);
        if (!response.ok) throw new Error("unread");
        const next: ShopJobView | null = await response.json();
        again = next === null || next.status === "queued" || next.status === "running";
        if (!cancelled) {
          setView(next);
          setUnread(false);
          if (
            next !== null &&
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
      if (!cancelled) timer = setTimeout(again ? read : watch, again ? 1000 : 10_000);
    };
    const watch = async () => {
      try {
        const response = await asked("?latest");
        const latest: Pick<ShopJobView, "id" | "revision"> | null = response.ok
          ? await response.json()
          : previous;
        if (!cancelled && (latest?.id !== previous?.id || latest?.revision !== previous?.revision))
          return void read();
      } catch {}
      if (!cancelled) timer = setTimeout(watch, 10_000);
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
