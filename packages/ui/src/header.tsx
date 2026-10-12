/**
 * The parts every surface's header is drawn from: the lockup, the sections and
 * who is signed in with the way out. They are parts rather than one bar because
 * surfaces place them differently (the dashboard's sections sit in a sidebar,
 * its account in the bar over the page), and the placing is the surface's own
 * layout, never the shared language's.
 */

import type { ReactNode } from "react";
import { Form, Link } from "react-router";

/** A link home; the mark is fetched from the shared assets every surface serves. */
export function BrandLockup({ home = "/" }: Readonly<{ home?: string }>) {
  return (
    <a className="brand" href={home} aria-label="Agentify home">
      <img className="brand-mark" src="/assets/agentify-mark.svg" alt="" width="30" height="30" />
      <span>Agentify</span>
    </a>
  );
}

/**
 * `to` is a section this application draws, followed without a page load and
 * fetched while the pointer rests on it; `href` is a page something else
 * serves, loaded whole.
 */
export type Section = Readonly<
  { key: string; label: ReactNode; current?: boolean } & (
    | { to: string; href?: never }
    | { href: string; to?: never }
  )
>;

/** The section on screen is named as current and is not a link to itself. */
export function SectionNav({
  label,
  sections,
  className,
}: Readonly<{ label: string; sections: readonly Section[]; className?: string }>) {
  return (
    <nav className={className} aria-label={label}>
      {sections.map((section) =>
        section.current === true ? (
          <span key={section.key} aria-current="page">
            {section.label}
          </span>
        ) : section.to === undefined ? (
          <a key={section.key} href={section.href}>
            {section.label}
          </a>
        ) : (
          <Link key={section.key} to={section.to} prefetch="intent">
            {section.label}
          </Link>
        ),
      )}
    </nav>
  );
}

/**
 * The whole address is in the title, so a surface may cut it short where the
 * bar is narrow. The way out is a form, because signing out changes something
 * and a link can be followed by anything that reads the page; it loads the
 * next page whole, so nothing drawn for the address stays in the tab's memory.
 */
export function SignedIn({
  who,
  account,
  signOut,
  className,
}: Readonly<{
  who: string;
  /** The page about the account, where the address links to. */
  account: string;
  /** Where the sign-out form posts. */
  signOut: string;
  className?: string;
}>) {
  return (
    <div className={className}>
      <a href={account} title={who}>
        {who}
      </a>
      <Form method="post" action={signOut} reloadDocument>
        <button type="submit">Sign out</button>
      </Form>
    </div>
  );
}
