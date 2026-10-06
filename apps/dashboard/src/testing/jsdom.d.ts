/**
 * The part of jsdom the cabinet's one browser test touches.
 *
 * jsdom ships no type declarations of its own and `@types/jsdom` is a package
 * this repository does not have, so importing it is an implicit `any` and the
 * typecheck refuses. This names the four members the test uses instead of
 * pulling in a second dependency to describe the first.
 *
 * Deliberately narrow, and it stays that way. A hand-written declaration is a
 * claim about somebody else's package that nothing checks, so the less of
 * their surface it claims, the less of it can quietly become untrue — and the
 * test fails loudly at runtime if any of this stops being so.
 */
declare module "jsdom" {
  /** The window as `beforeParse` hands it over: before any script has run. */
  export interface JsdomWindow {
    Date: DateConstructor;
    setInterval: (handler: () => void, every?: number) => number;
    clearInterval: (timer?: number) => void;
    readonly document: {
      querySelector(selectors: string): unknown;
    };
  }

  export interface JsdomOptions {
    /** Inline scripts run only with this; without it the page is inert. */
    runScripts?: "dangerously" | "outside-only";
    /** The one seam before parsing, which is when an inline script runs. */
    beforeParse?: (window: JsdomWindow) => void;
  }

  export class JSDOM {
    constructor(html: string, options?: JsdomOptions);
    readonly window: JsdomWindow;
  }
}
