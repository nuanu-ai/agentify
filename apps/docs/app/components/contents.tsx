import { DOCS_GROUPS } from "@agentify/ui/docs";
import { Fragment } from "react";
import { Link } from "react-router";

export type Section = Readonly<{ id: string; title: string }>;

/**
 * The documentation's pages in their groups, with the sections of the page on
 * screen under its name and the one being read marked. A page's data is
 * fetched as soon as its link is on the screen, so a click draws the page
 * from what is already here. `label` tells this list apart from the menu's.
 */
export function Contents({
  current,
  sections = [],
  inView = null,
  label,
}: Readonly<{
  current: string | null;
  sections?: readonly Section[];
  inView?: string | null;
  label: string;
}>) {
  return (
    <nav className="docs-contents" aria-label={label}>
      {DOCS_GROUPS.map((group) => (
        <div className="docs-group" key={group.label}>
          <span className="editorial-label">{group.label}</span>
          {group.entries.map((entry) => {
            const here = entry.section === undefined && entry.path === current;
            const to = entry.section === undefined ? entry.path : `${entry.path}#${entry.section}`;
            return (
              <Fragment key={to}>
                <Link to={to} prefetch="viewport" aria-current={here ? "page" : undefined}>
                  {entry.label}
                </Link>
                {here && sections.length > 0 ? (
                  <div className="docs-sections">
                    {sections.map((section) => (
                      <a
                        href={`#${section.id}`}
                        key={section.id}
                        aria-current={section.id === inView ? "location" : undefined}
                      >
                        {section.title}
                      </a>
                    ))}
                  </div>
                ) : null}
              </Fragment>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
