/**
 * What services Agentify does not run were seen to answer, each kept with
 * where and when it was read: Coinbase's public exchange rates, WooCommerce's
 * own words as one release's source writes them, and the refusal codes the
 * payment facilitator's packages name. A test that stands in for one of these
 * services takes its answer from here instead of writing one by hand, and
 * `pnpm smoke:recorded` asks the services again.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const recorded = <Kept>(file: string): Kept =>
  JSON.parse(readFileSync(join(import.meta.dirname, file), "utf8")) as Kept;

const answerIn = (file: string) => {
  const kept = recorded<{ url: string; readAt: string; status: number; body: unknown }>(file);
  return {
    url: kept.url,
    readAt: new Date(kept.readAt),
    status: kept.status,
    /** The JSON the service sent, written without spaces as Coinbase writes it. */
    body: JSON.stringify(kept.body),
  } as const;
};

/** Coinbase's public exchange rates for one US dollar. */
export const coinbaseRates = answerIn("coinbase-exchange-rates.json");

/** Coinbase's answer when asked for rates from a base currency it does not know. */
export const coinbaseUnknownBase = answerIn("coinbase-unknown-base.json");

/** The rate `coinbaseRates` gives for `currency`, as Coinbase wrote it; throws for one it does not list. */
export const coinbaseRateOf = (currency: string): string => {
  const { rates } = (JSON.parse(coinbaseRates.body) as { data: { rates: Record<string, string> } })
    .data;
  const rate = Object.hasOwn(rates, currency) ? rates[currency] : undefined;
  if (rate === undefined)
    throw new Error(`Coinbase's recorded answer lists no rate for ${currency}`);
  return rate;
};

/** A statement in WooCommerce's source, with its whitespace collapsed to single spaces. */
interface WooStatement {
  readonly file: string;
  readonly statement: string;
}

/** WooCommerce's own words, as the source of one release writes them. */
export const wooCommerce = recorded<{
  readonly release: string;
  /** Where the release's files are read from: this followed by a `file`. */
  readonly source: string;
  readonly readAt: string;
  readonly currencies: { readonly file: string; readonly codes: readonly string[] };
  readonly refusals: readonly (WooStatement & {
    readonly code: string;
    /** None for a code that is no answer of its own but an entry in a cart's errors. */
    readonly status: number | null;
    readonly message: string | null;
    /** The statement that sets the post type a code written with `{$this->post_type}` takes. */
    readonly postType?: WooStatement;
  })[];
}>("woocommerce.json");

/**
 * WooCommerce's refusal `code` as a shop sends it: the status and words the
 * recorded release writes, in WordPress's body for an error. Throws for a code
 * the recording does not hold, or one that is never an answer of its own.
 */
export const wooRefusal = (code: string) => {
  const refusal = wooCommerce.refusals.find((one) => one.code === code);
  if (refusal === undefined || refusal.status === null || refusal.message === null) {
    throw new Error(`WooCommerce ${wooCommerce.release} is not recorded answering ${code}`);
  }
  const { status, message } = refusal;
  return { status, body: { code, message, data: { status } } } as const;
};

/** The refusal codes the payment facilitator's own packages name, read from their npm tarballs. */
export const facilitatorRefusals = recorded<{
  readonly readAt: string;
  readonly packages: readonly {
    readonly package: string;
    readonly version: string;
    /** The file inside the package's tarball that declares the lists. */
    readonly file: string;
    readonly lists: Readonly<Record<string, readonly string[]>>;
  }[];
}>("facilitator-refusal-codes.json");
