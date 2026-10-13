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
   * The page through the very screens and chrome the surface draws, from data
   * its own view functions build: as its server sends it, or, with a scene,
   * as the page's script leaves it.
   */
  readonly draw: () => ReactElement;
  /**
   * For a state only the page's script reaches (an answer it asked for, a
   * press): the browser the page runs in. Without one, the state is the page
   * as the server sends it, every part on it drawn.
   */
  readonly scene?: BrowserScene;
}

/** How the site answers one of the page's requests: its status and its JSON body. */
export interface SiteAnswer {
  readonly status: number;
  readonly body?: unknown;
}

export interface BrowserScene {
  /**
   * The site's answers to what the page asks for, by method and path, such as
   * `"GET /api/v2/session"`; a request it does not name fails the drawing.
   */
  readonly answers?: Readonly<Record<string, SiteAnswer>>;
  /** What the tab's session storage holds when the page loads. */
  readonly session?: Readonly<Record<string, string>>;
  /** What the site's local storage holds when the page loads. */
  readonly local?: Readonly<Record<string, string>>;
  /** What the person does, in order, each once the page shows the words it acts on. */
  readonly steps?: readonly Readonly<{ shows: string; does: (page: Document) => void }>[];
  /** Words the page shows once it is in the state; it is drawn then. */
  readonly shows: string;
}

export interface GallerySurface {
  /** Lowercase letters, digits and hyphens; every state's id starts with it. */
  readonly id: string;
  /** As a person would call it. */
  readonly name: string;
  readonly states: readonly GalleryState[];
}
