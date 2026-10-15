import "@agentify/visual/editorial.css";
import type { ReactNode } from "react";
import { publicSiteSchema } from "../lib/schema";
import { usePublicConfig } from "./public-config";
import { SiteFooter, SiteHeader } from "./site-chrome";
import { StructuredData } from "./structured-data";

export type EditorialSection = Readonly<{
  id: string;
  title: string;
  content: ReactNode;
}>;

export function EditorialPage({
  eyebrow,
  intro,
  sections,
  structuredData = false,
  title,
}: Readonly<{
  eyebrow: string;
  intro: string;
  sections: readonly EditorialSection[];
  structuredData?: boolean;
  title: string;
}>) {
  const config = usePublicConfig();
  return (
    <>
      {structuredData ? <StructuredData schema={publicSiteSchema(config)} /> : null}
      <SiteHeader />
      <main className="editorial container" id="main">
        <aside className="editorial-contents">
          <span>On this page</span>
          {sections.map((section) => (
            <a href={`#${section.id}`} key={section.id}>
              {section.title}
            </a>
          ))}
        </aside>
        <article className="editorial-article">
          <div className="eyebrow">{eyebrow}</div>
          <h1>{title}</h1>
          <p>{intro}</p>
          <details className="editorial-outline">
            <summary>On this page</summary>
            <nav aria-label="On this page">
              {sections.map((section) => (
                <a href={`#${section.id}`} key={section.id}>
                  {section.title}
                </a>
              ))}
            </nav>
          </details>
          {sections.map((section) => (
            <section id={section.id} key={section.id}>
              <h2>{section.title}</h2>
              {section.content}
            </section>
          ))}
        </article>
      </main>
      <SiteFooter />
    </>
  );
}

export function ProseList({ children }: Readonly<{ children: ReactNode }>) {
  return <ul className="editorial-list">{children}</ul>;
}

export function Notice({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="editorial-notice">{children}</div>;
}
