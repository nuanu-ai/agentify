/**
 * What a surface hands the gallery: its screens in each state they can be
 * seen in, each drawn by the surface's own components. A surface keeps them
 * in a module of its own and registers it in `surfaces.ts`; `pnpm gallery`
 * draws them all into one static page.
 */

import type { ReactElement } from "react";

export interface GalleryState {
  /**
   * The state's anchor in the page and the name a comment uses for it, so it
   * stays the same while the state exists: lowercase letters, digits and
   * hyphens, starting with the surface's own id.
   */
  readonly id: string;
  /** The screen as a person would call it; every state of one screen says it the same way. */
  readonly screen: string;
  /** Where the page appears, as the browser's address bar shows it. */
  readonly address: string;
  /** One sentence: when a person sees this. */
  readonly when: string;
  /** One sentence: what in the system causes it. */
  readonly cause: string;
  /**
   * The page as the surface's server sends it, through the very screens and
   * chrome the surface draws, from data its own view functions build.
   */
  readonly draw: () => ReactElement;
}

export interface GallerySurface {
  /** Lowercase letters, digits and hyphens; every state's id starts with it. */
  readonly id: string;
  /** As a person would call it. */
  readonly name: string;
  readonly states: readonly GalleryState[];
}
