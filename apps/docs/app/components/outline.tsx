import { type MouseEvent, useRef } from "react";
import type { Section } from "./contents.js";

/**
 * The page's sections on a phone, where the contents column has no room: a
 * disclosure in the bar that stays under the site header, with the section
 * being read marked and a way back to the top. Following one of its links
 * folds it again.
 */
export function Outline({
  sections,
  inView,
}: Readonly<{ sections: readonly Section[]; inView: string | null }>) {
  const outline = useRef<HTMLDetailsElement>(null);
  const fold = () => {
    if (outline.current !== null) outline.current.open = false;
  };
  const toTop = (event: MouseEvent) => {
    event.preventDefault();
    fold();
    window.scrollTo({ top: 0 });
  };
  return (
    <details className="editorial-outline docs-outline" ref={outline}>
      <summary>On this page</summary>
      <nav aria-label="On this page">
        {/* biome-ignore lint/a11y/useValidAnchor: the fragment works without script; the handler folds the outline and scrolls to the page's top */}
        <a href="#main" className="docs-to-top" onClick={toTop}>
          Return to top
        </a>
        {sections.map((section) => (
          <a
            href={`#${section.id}`}
            key={section.id}
            onClick={fold}
            aria-current={section.id === inView ? "location" : undefined}
          >
            {section.title}
          </a>
        ))}
      </nav>
    </details>
  );
}
