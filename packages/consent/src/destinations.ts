/**
 * The measuring services a visitor's choice lets a page load: PostHog for
 * product analytics and the Meta pixel for ads measurement. Each is loaded on
 * the first event a visitor allowed, never before, and only where the
 * deployment names it for the environment it runs in, so a test channel
 * configured with the live channel's keys sends nothing.
 */

import {
  CONSENT_STORAGE_KEY,
  type ConsentSnapshot,
  POSTHOG_BROWSER_OPTIONS,
  readCurrentConsent,
} from "@agentify/analytics/browser";
import type { PostHog } from "posthog-js";
import { CONSENT_CHANGED_EVENT } from "./events.js";

type Environment = "local" | "test" | "preview" | "production";

/** What a deployment tells the browser about where its measurements go. */
export type BrowserAnalyticsConfig = Readonly<{
  runtimeEnvironment: Environment;
  posthog: Readonly<{
    key: string | null;
    host: string | null;
    destinationEnvironment: Environment;
  }>;
  meta: Readonly<{
    pixelId: string | null;
    destinationEnvironment: Environment;
  }>;
}>;

let posthogPromise: Promise<PostHog> | undefined;

/** PostHog, started once with every capture of its own off, or null where none is named for this environment. */
export function posthogOf(config: BrowserAnalyticsConfig): Promise<PostHog> | null {
  const { key, host, destinationEnvironment } = config.posthog;
  if (!key || !host || destinationEnvironment !== config.runtimeEnvironment) return null;
  if (posthogPromise === undefined) {
    posthogPromise = import("posthog-js").then(({ posthog }) => {
      posthog.init(key, { api_host: host, ...POSTHOG_BROWSER_OPTIONS });
      return posthog;
    });
  }
  return posthogPromise;
}

type MetaWindow = Window & {
  fbq?: ((...args: unknown[]) => void) & {
    callMethod?: (...args: unknown[]) => void;
    queue?: unknown[][];
    loaded?: boolean;
    version?: string;
    disablePushState?: boolean;
  };
  _fbq?: (...args: unknown[]) => void;
};

type Pixel = NonNullable<MetaWindow["fbq"]>;

/**
 * Holds a started pixel to the visitor's later choices, made on this page or
 * in another of the site's tabs: turning ads measurement off revokes it until
 * a choice turns it on again.
 */
const followChoices = (fbq: Pixel): void => {
  const hold = (snapshot: ConsentSnapshot | undefined) =>
    fbq("consent", snapshot?.categories.ads_measurement === true ? "grant" : "revoke");
  window.addEventListener(CONSENT_CHANGED_EVENT, (event) =>
    hold((event as CustomEvent<ConsentSnapshot>).detail),
  );
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === CONSENT_STORAGE_KEY) {
      hold(readCurrentConsent(window.localStorage));
    }
  });
};

/**
 * The Meta pixel, started once, or undefined where none is named for this
 * environment. It counts no move by itself and follows the visitor's later
 * choices.
 */
export function metaPixelOf(config: BrowserAnalyticsConfig): MetaWindow["fbq"] | undefined {
  const { pixelId, destinationEnvironment } = config.meta;
  if (!pixelId || destinationEnvironment !== config.runtimeEnvironment) return undefined;
  const target = window as MetaWindow;
  if (!target.fbq) {
    const fbq = ((...args: unknown[]) => {
      if (fbq.callMethod) fbq.callMethod(...args);
      else fbq.queue?.push(args);
    }) as Pixel;
    fbq.queue = [];
    fbq.loaded = true;
    fbq.version = "2.0";
    // Each page sends its own view of a move. Left on, the pixel would also
    // count every history change by itself, a move after a withdrawal included.
    fbq.disablePushState = true;
    target.fbq = fbq;
    target._fbq = fbq;
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://connect.facebook.net/en_US/fbevents.js";
    document.head.appendChild(script);
    fbq("init", pixelId);
    followChoices(fbq);
  }
  return target.fbq;
}
