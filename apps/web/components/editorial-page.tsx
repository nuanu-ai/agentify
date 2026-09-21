import Link from "next/link";
import React, { type ReactNode } from "react";

import { Brand } from "./brand";
import { SiteDoors, SiteFooter } from "./site-chrome";
import { StructuredData } from "./structured-data";
import { publicSiteSchema } from "../lib/schema";
import styles from "./editorial-page.module.css";

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
  return (
    <>
      {structuredData ? <StructuredData schema={publicSiteSchema()} /> : null}
      <header className={styles.header}>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <div className="container">
          <Brand />
          <div className={styles.headerLinks}>
            <nav aria-label="Trust pages">
              <Link href="/scanner">Scanner</Link>
              <Link href="/methodology">Methodology</Link>
              <Link href="/privacy">Privacy</Link>
            </nav>
            <SiteDoors />
          </div>
        </div>
      </header>
      <main className={`${styles.layout} container`} id="main">
        <aside className={styles.desktopToc}>
          <span>On this page</span>
          {sections.map((section) => (
            <a href={`#${section.id}`} key={section.id}>
              {section.title}
            </a>
          ))}
        </aside>
        <article className={styles.article}>
          <div className="eyebrow">{eyebrow}</div>
          <h1>{title}</h1>
          <p className={styles.intro}>{intro}</p>
          <details className={styles.mobileToc}>
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
  return <ul className={styles.proseList}>{children}</ul>;
}

export function Notice({ children }: Readonly<{ children: ReactNode }>) {
  return <div className={styles.notice}>{children}</div>;
}
