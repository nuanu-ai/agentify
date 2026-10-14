/**
 * The measuring services a visitor's choice lets a page load: PostHog for
 * product analytics and the Meta pixel for ads measurement. Each is loaded on
 * the first event a visitor allowed, never before, and only where the
 * deployment names it for the environment it runs in, so a test channel
 * configured with the live channel's keys sends nothing.
 */

import { POSTHOG_BROWSER_OPTIONS } from "@agentify/analytics/browser";
import type { PostHog } from "posthog-js";

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
  };
  _fbq?: (...args: unknown[]) => void;
};

/** The Meta pixel, started once, or undefined where none is named for this environment. */
export function metaPixelOf(config: BrowserAnalyticsConfig): MetaWindow["fbq"] | undefined {
  const { pixelId, destinationEnvironment } = config.meta;
  if (!pixelId || destinationEnvironment !== config.runtimeEnvironment) return undefined;
  const target = window as MetaWindow;
  if (!target.fbq) {
    const fbq = ((...args: unknown[]) => {
      if (fbq.callMethod) fbq.callMethod(...args);
      else fbq.queue?.push(args);
    }) as NonNullable<MetaWindow["fbq"]>;
    fbq.queue = [];
    fbq.loaded = true;
    fbq.version = "2.0";
    target.fbq = fbq;
    target._fbq = fbq;
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://connect.facebook.net/en_US/fbevents.js";
    document.head.appendChild(script);
    fbq("init", pixelId);
  }
  return target.fbq;
}
