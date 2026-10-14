import type { ReactNode } from "react";
import { BrandLockup } from "./header.js";

export interface FooterLink {
  readonly href: string;
  readonly label: string;
}

/**
 * The ink band at the foot of a page. Its links are whole addresses on the
 * shared origin, because what they lead to is served beside this surface
 * rather than by it; `children` are controls drawn after them, such as the
 * button that opens the privacy choices.
 */
export function Footer({
  links,
  children,
}: Readonly<{ links: readonly FooterLink[]; children?: ReactNode }>) {
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
          {children}
        </nav>
        <span className="foot-copy">© 2026 Agentify</span>
      </div>
    </footer>
  );
}
