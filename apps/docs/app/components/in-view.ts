import { useEffect, useState } from "react";

/** How far under the window's top a section's heading counts as reached: the site header and a little air. */
const REACHED = 104;

/**
 * The section being read, marked in the outline as the page scrolls, as
 * VitePress marks it: none at the top of the page, the last once the page is
 * scrolled to its end, and otherwise the last section whose heading has
 * passed under the site header.
 */
export function useSectionInView(ids: readonly string[]): string | null {
  const [inView, setInView] = useState<string | null>(null);
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const scrolled = window.scrollY;
      const atEnd =
        Math.abs(scrolled + window.innerHeight - document.documentElement.scrollHeight) < 2;
      let reached: string | null = null;
      if (ids.length > 0 && scrolled >= 1) {
        if (atEnd) reached = ids.at(-1) ?? null;
        else {
          for (const id of ids) {
            const heading = document.getElementById(id);
            if (heading === null || heading.getBoundingClientRect().top > REACHED) break;
            reached = id;
          }
        }
      }
      setInView(reached);
    };
    const later = () => {
      frame ||= requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", later, { passive: true });
    window.addEventListener("resize", later);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", later);
      window.removeEventListener("resize", later);
    };
  }, [ids]);
  return inView;
}
