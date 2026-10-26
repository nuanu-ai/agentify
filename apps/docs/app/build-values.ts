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
  percentOf,
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
 * count it in, a count, a part of a total said as a percentage, or text
 * written as it stands.
 */
type BuildValue =
  | { readonly ms: number; readonly unit: Unit }
  | { readonly count: number }
  | { readonly part: number; readonly total: number }
  | { readonly text: string };

const sdk = JSON.parse(
  readFileSync(join(APP, "..", "..", "packages", "sdk", "package.json"), "utf8"),
) as { version: string };

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
  commission: {
    part: COMMISSION_RATE.commissionAllocation,
    total: COMMISSION_RATE.totalAllocation,
  },
  "merchant-share": {
    part: COMMISSION_RATE.totalAllocation - COMMISSION_RATE.commissionAllocation,
    total: COMMISSION_RATE.totalAllocation,
  },
};

/**
 * A value as its sentence asks for it. With no form, a stretch of time is in
 * words with its unit and a rate is a percentage. A stretch of time also has
 * `number`, the count of its unit in words alone, and one counted in seconds
 * has `short`, digits as a drawing writes them, "30 s"; a rate has `words`, as
 * a screen reader reads it.
 */
function said(value: BuildValue, form: string | undefined): string {
  if ("ms" in value) {
    if (form === undefined) return durationInWords(value.ms, value.unit);
    if (form === "number") return inWords(unitsIn(value.ms, value.unit));
    if (form === "short" && value.unit === "second") return `${unitsIn(value.ms, "second")} s`;
    throw new Error(
      "a stretch of time is written with no form or as :number, and one in seconds as :short",
    );
  }
  if ("part" in value) {
    const percent = percentOf(value.part, value.total);
    if (form === undefined) return percent;
    if (form === "words") return percent.replace(/%$/, " percent");
    throw new Error("a rate is written with no form, or as :words");
  }
  if (form !== undefined) throw new Error("a count or a text is written with no form");
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
