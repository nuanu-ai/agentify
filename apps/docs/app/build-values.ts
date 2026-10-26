/**
 * What a page names that the build knows and no deployment decides: the
 * release of `@nuanu-ai/agentify` the pages describe, read from the package
 * in this repository, and every number Agentify publishes about its own
 * behaviour, read from `@agentify/core/published`, whose constants the
 * gateway runs. A writer names one as
 * `{{sdk-version}}` or `{{quote-ttl}}`, and it is written into the page, its
 * Markdown, its drawings and the search index alike, code blocks included,
 * before anything else reads the source. A name this does not know is left
 * only where it is a site value, which Caddy fills; any other stops the build.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMMISSION_RATE,
  DEFAULT_ASYNC_FULFILLMENT_MS,
  durationInWords,
  HANDLER_ANSWER_MS,
  inWords,
  LAPSED_KEPT_MS,
  percentagesOf,
  QUOTE_RESPONSE_MS,
  QUOTE_TTL_MS,
  REDELIVERY_MAX_ATTEMPTS,
  SETTLE_BEFORE_GOODS_MS,
  SETTLE_RESPONSE_MS,
  SILENT_AFTER_MS,
  SYNC_BUDGET_MS,
  SYNC_RESPONSE_MS,
  type Unit,
  unitsIn,
  WAITING_FOR_PAYMENT_AT_MOST,
} from "@agentify/core/published";
import { isSiteValueName } from "./site-values.js";
import { APP } from "./where.server.js";

/**
 * A value the build writes in: a stretch of time with the unit its sentences
 * count it in, a count, or text written as it stands.
 */
type BuildValue =
  | { readonly ms: number; readonly unit: Unit }
  | { readonly count: number }
  | { readonly text: string };

const sdk = JSON.parse(
  readFileSync(join(APP, "..", "..", "packages", "sdk", "package.json"), "utf8"),
) as { version: string };

const shares = percentagesOf(COMMISSION_RATE);

const BUILD_VALUES: Readonly<Record<string, BuildValue>> = {
  "sdk-version": { text: sdk.version },
  "quote-response": { ms: QUOTE_RESPONSE_MS, unit: "second" },
  "quote-ttl": { ms: QUOTE_TTL_MS, unit: "second" },
  "handler-answer": { ms: HANDLER_ANSWER_MS, unit: "second" },
  "sync-response": { ms: SYNC_RESPONSE_MS, unit: "second" },
  "sync-budget": { ms: SYNC_BUDGET_MS, unit: "second" },
  "settle-response": { ms: SETTLE_RESPONSE_MS, unit: "second" },
  "settle-before-goods": { ms: SETTLE_BEFORE_GOODS_MS, unit: "second" },
  "default-async-fulfillment": { ms: DEFAULT_ASYNC_FULFILLMENT_MS, unit: "day" },
  "redelivery-max-attempts": { count: REDELIVERY_MAX_ATTEMPTS },
  "waiting-for-payment-at-most": { count: WAITING_FOR_PAYMENT_AT_MOST },
  "silent-after": { ms: SILENT_AFTER_MS, unit: "minute" },
  "lapsed-kept": { ms: LAPSED_KEPT_MS, unit: "day" },
  commission: { text: shares.commission },
  "merchant-share": { text: shares.share },
};

/** How a drawing abbreviates each unit after its digits, as in "30 s". */
const SHORT_UNIT: Readonly<Record<Unit, string>> = { second: "s", minute: "min", day: "d" };

/**
 * A value as its sentence asks for it: with no form, in words with its unit;
 * `number`, the count of its unit in words alone; `short`, digits and the
 * unit's abbreviation. Only a stretch of time has the two forms.
 */
function said(value: BuildValue, form: string | undefined): string {
  if ("ms" in value) {
    if (form === undefined) return durationInWords(value.ms, value.unit);
    if (form === "number") return inWords(unitsIn(value.ms, value.unit));
    if (form === "short") return `${unitsIn(value.ms, value.unit)} ${SHORT_UNIT[value.unit]}`;
    throw new Error("a stretch of time is written with no form, or as :number or :short");
  }
  if (form !== undefined) throw new Error("only a stretch of time has a form");
  return "count" in value ? inWords(value.count) : value.text;
}

/** A name, with a capital where its sentence opens on it, and a form after a colon. */
const NAMED = /(?<!<!--)\{\{([A-Za-z][a-z-]*)(?::([a-z]+))?\}\}/g;

/** `source` with every value in `values` written in, as `withBuildValues` writes the build's. */
export function writtenIn(source: string, values: Readonly<Record<string, BuildValue>>): string {
  return source.replace(NAMED, (whole, written: string, form: string | undefined) => {
    const name = written.toLowerCase();
    const capital = written !== name;
    const value = Object.hasOwn(values, name) ? values[name] : undefined;
    if (value === undefined) {
      if (!capital && form === undefined && isSiteValueName(name)) return whole;
      throw new Error(
        `${whole} names no value the build writes in and no value a deployment fills`,
      );
    }
    try {
      const text = said(value, form);
      return capital ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
    } catch (error) {
      throw new Error(`${whole} cannot be written in: ${(error as Error).message}`);
    }
  });
}

/** A page's source with every value the build knows written in. */
export const withBuildValues = (source: string): string => writtenIn(source, BUILD_VALUES);
