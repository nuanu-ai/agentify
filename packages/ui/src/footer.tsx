import { BrandLockup } from "./header.js";

export interface FooterLink {
  readonly href: string;
  readonly label: string;
}

/**
 * The ink band at the foot of a page. Its links are whole addresses on the
 * shared origin, because what they lead to is served beside this surface
 * rather than by it.
 */
export function Footer({ links }: Readonly<{ links: readonly FooterLink[] }>) {
  return (
    <footer className="foot">
      <div className="foot-inner container">
        <BrandLockup home="/" />
        <nav className="foot-links" aria-label="Agentify">
          {links.map((link) => (
            <a key={link.href} href={link.href}>
              {link.label}
            </a>
          ))}
        </nav>
        <span className="foot-copy">© 2026 Agentify</span>
      </div>
    </footer>
  );
}
