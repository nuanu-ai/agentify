import type { ReactNode } from "react";
import { type Drawn, HOME, type Place, PlaceLink } from "./header.js";
import { BrandMark } from "./mark.js";

/**
 * The pages every page of the site leads to from its foot, whichever surface
 * draws it. The abuse contact is the section of the scanner's page that prints
 * the address the deployment is configured with, since not every surface is
 * told that address.
 */
const FOOT_PLACES: readonly (Place & Readonly<{ label: string }>)[] = [
  { owner: "scanner", path: "/agentic-shop", label: "Sell to agents" },
  { owner: "docs", path: "/", label: "Docs" },
  { owner: "scanner", path: "/privacy", label: "Privacy" },
  { owner: "scanner", path: "/terms", label: "Terms" },
  { owner: "scanner", path: "/data-request", label: "Data request" },
  { owner: "docs", path: "/scanner#opt-out", label: "Report abuse" },
];

/**
 * The foot of every page of the site: the lockup, the same links on every
 * surface, a page the surface serves followed in place and any other loaded
 * whole, and then `children`, the surface's own controls, such as the button
 * that opens the privacy choices.
 */
export function SiteFooter({ children, ...drawn }: Drawn & Readonly<{ children?: ReactNode }>) {
  return (
    <footer className="foot">
      <div className="foot-inner container">
        <PlaceLink className="brand" place={HOME} {...drawn}>
          <BrandMark className="brand-mark" />
          <span>Agentify</span>
        </PlaceLink>
        <nav className="foot-links" aria-label="Agentify">
          {FOOT_PLACES.map((place) => (
            <PlaceLink key={place.label} place={place} {...drawn}>
              {place.label}
            </PlaceLink>
          ))}
          {children}
        </nav>
        <span className="foot-copy">© 2026 Agentify</span>
      </div>
    </footer>
  );
}
