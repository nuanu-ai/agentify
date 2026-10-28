/**
 * What a page names that the build knows and no deployment decides: the
 * release of `@nuanu-ai/agentify` the pages describe, read from the package
 * in this repository, a parcel's purchase with the example address the
 * contract's own schema publishes, the smallest price the contract's price
 * rule sells at, and every number Agentify publishes about its own
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
  ordinalInWords,
  percentOf,
  QUOTE_RESPONSE_MS,
  QUOTE_TTL_MS,
  REDELIVERY_MAX_ATTEMPTS,
  SETTLE_BEFORE_GOODS_MS,
  SETTLE_RESPONSE_MS,
  SILENT_AFTER_MS,
  SYNC_BUDGET_MS,
  SYNC_RESPONSE_MS,
  UNSERVED_AT_MOST,
  type Unit,
  unitsIn,
} from "@agentify/core/published";
import { ORDER_CALL_ERROR_CODES, ShipToSchema, SMALLEST_PRICE } from "@nuanu-ai/agentify-contracts";
import {
  ANSWER_NOT_UNDERSTOOD,
  CALL_DID_NOT_REACH_US,
  OUTCOME_UNKNOWN,
} from "../../../packages/sdk/src/client.js";
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

const [address] = (ShipToSchema.meta()?.examples as readonly unknown[] | undefined) ?? [];
if (address === undefined) throw new Error("the contract's address schema publishes no example");

const toolCodes = [ANSWER_NOT_UNDERSTOOD, CALL_DID_NOT_REACH_US, OUTCOME_UNKNOWN];

const BUILD_VALUES: Readonly<Record<string, BuildValue>> = {
  "order-call-codes": { count: ORDER_CALL_ERROR_CODES.length + toolCodes.length },
  "gateway-order-call-codes": { count: ORDER_CALL_ERROR_CODES.length },
  "tool-order-call-codes": { count: toolCodes.length },
  "sdk-version": { text: sdk.version },
  "parcel-purchase": { text: JSON.stringify({ params: {}, ship_to: address }, null, 2) },
  "smallest-price": { text: SMALLEST_PRICE },
  "quote-response": { ms: QUOTE_RESPONSE_MS, unit: "second" },
  "quote-ttl": { ms: QUOTE_TTL_MS, unit: "second" },
  "handler-answer": { ms: HANDLER_ANSWER_MS, unit: "second" },
  "sync-response": { ms: SYNC_RESPONSE_MS, unit: "second" },
  "sync-budget": { ms: SYNC_BUDGET_MS, unit: "second" },
  "settle-response": { ms: SETTLE_RESPONSE_MS, unit: "second" },
  "settle-before-goods": { ms: SETTLE_BEFORE_GOODS_MS, unit: "second" },
  "default-async-fulfillment": { ms: DEFAULT_ASYNC_FULFILLMENT_MS, unit: "day" },
  "redelivery-max-attempts": { count: REDELIVERY_MAX_ATTEMPTS },
  "unserved-at-most": { count: UNSERVED_AT_MOST },
  "silent-after": { ms: SILENT_AFTER_MS, unit: "minute" },
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
 * has `short`, digits as a drawing writes them, "30 s"; a count has
 * `ordinal`, its place in a row, "tenth"; a rate has `words`, as a screen
 * reader reads it.
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
  if ("count" in value) {
    if (form === undefined) return inWords(value.count);
    if (form === "ordinal") return ordinalInWords(value.count);
    throw new Error("a count is written with no form, or as :ordinal");
  }
  if (form !== undefined) throw new Error("a text is written with no form");
  return value.text;
}

/** A name, with a capital where its sentence opens on it, and a form after a colon. */
const NAMED = /\{\{([A-Za-z][a-z-]*)(?::([a-z]+))?\}\}/g;

/** Whatever opens as a name does, up to its closing braces or the end of its line. */
const OPENED = /\{\{[^}\n]*(?:\}\})?/g;

/** A value a deployment fills, as a page leaves it for Caddy. */
const LEFT_FOR_CADDY = /^\{\{([a-z-]+)\}\}$/;

function written(source: string, values: Readonly<Record<string, BuildValue>>): string {
  const filled = source.replace(NAMED, (whole, named: string, form: string | undefined) => {
    const name = named.toLowerCase();
    const capital = named !== name;
    const value = Object.hasOwn(values, name) ? values[name] : undefined;
    if (value === undefined) {
      if (!isSiteValueName(name)) {
        throw new Error(
          `${whole} names no value the build writes in and no value a deployment fills`,
        );
      }
      if (capital || form !== undefined) {
        throw new Error(
          `${whole}: a value a deployment fills is written {{${name}}}, with no capital and no form`,
        );
      }
      return whole;
    }
    try {
      const text = said(value, form);
      return capital ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
    } catch (error) {
      throw new Error(`${whole} cannot be written in: ${(error as Error).message}`);
    }
  });
  for (const [left] of filled.matchAll(OPENED)) {
    const name = LEFT_FOR_CADDY.exec(left)?.[1];
    if (name === undefined || !isSiteValueName(name)) {
      throw new Error(
        `${left} is not written as a name: a name is lower-case words joined by hyphens, as {{quote-ttl}}, with a capital first letter where it opens a sentence and a lower-case form after a colon`,
      );
    }
  }
  return filled;
}

/**
 * `source` with every value in `values` written in, as `withBuildValues`
 * writes the build's, and a refusal for anything else written as a name,
 * which names `where` it was written when it is given.
 */
export function writtenIn(
  source: string,
  values: Readonly<Record<string, BuildValue>>,
  where?: string,
): string {
  try {
    return written(source, values);
  } catch (error) {
    throw where === undefined ? error : new Error(`${where}: ${(error as Error).message}`);
  }
}

/** A page's source with every value the build knows written in. */
export const withBuildValues = (source: string, where?: string): string =>
  writtenIn(source, BUILD_VALUES, where);
