/**
 * jsdom ships no types and this repository does not depend on `@types/jsdom`,
 * so this names only the members the one browser test uses. A hand-written
 * declaration is an unchecked claim about somebody else's package, so it stays
 * this narrow; the test fails at runtime if any of it stops being true.
 */
declare module "jsdom" {
  /** Before any script has run. */
  export interface JsdomWindow {
    Date: DateConstructor;
    setInterval: (handler: () => void, every?: number) => number;
    clearInterval: (timer?: number) => void;
    readonly document: {
      querySelector(selectors: string): unknown;
    };
  }

  export interface JsdomOptions {
    /** Inline scripts run only with this. */
    runScripts?: "dangerously" | "outside-only";
    /** The one hook before parsing, which is when an inline script runs. */
    beforeParse?: (window: JsdomWindow) => void;
  }

  export class JSDOM {
    constructor(html: string, options?: JsdomOptions);
    readonly window: JsdomWindow;
  }
}
