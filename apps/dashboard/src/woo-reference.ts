/**
 * The reference rate shown to a merchant beside the rate they set for a shop
 * priced in another currency: Coinbase's public exchange rates for one US
 * dollar, read without a key. It catches a mistyped rate and prices nothing,
 * so it is read only on the dashboard's screens and at Connect, never while a
 * buyer waits for a price. Coinbase's answer carries no time of its own, so the
 * moment kept is the one Agentify read it at.
 */

import { z } from "zod";

const REFERENCE_SOURCE = "Coinbase";

const COINBASE_RATES = "https://api.coinbase.com/v2/exchange-rates?currency=USD";

/** Short, because a merchant is waiting on a screen for it. */
const ANSWERS_WITHIN_MS = 3_000;

export type ReferenceRead =
  | {
      readonly ok: true;
      /** Units of the currency one US dollar buys, as Coinbase wrote it. */
      readonly rate: string;
      readonly source: typeof REFERENCE_SOURCE;
      readonly readAt: Date;
    }
  /**
   * `listed: false` is Coinbase answering for the dollar and naming no rate for
   * the currency; `listed: null` is no readable answer at all, which says
   * nothing about the currency.
   */
  | { readonly ok: false; readonly listed: false | null };

export type ReferenceRequest = (url: string, init: RequestInit) => Promise<Response>;

const AnswerSchema = z.object({
  data: z.object({ currency: z.literal("USD"), rates: z.record(z.string(), z.string()) }),
});

export const referenceRateOf = async (
  currency: string,
  parts: {
    readonly request?: ReferenceRequest;
    readonly now?: () => Date;
    readonly withinMs?: number;
  } = {},
): Promise<ReferenceRead> => {
  const unknown: ReferenceRead = { ok: false, listed: null };
  const within = parts.withinMs ?? ANSWERS_WITHIN_MS;
  let late: ReturnType<typeof setTimeout> | undefined;
  try {
    const asked = (async () => {
      const answered = await (parts.request ?? fetch)(COINBASE_RATES, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(within),
      });
      return answered.ok ? await answered.text() : null;
    })();
    const body = await Promise.race([
      asked,
      new Promise<null>((resolve) => {
        late = setTimeout(() => resolve(null), within);
      }),
    ]);
    asked.catch(() => undefined);
    if (body === null) return unknown;
    const read = AnswerSchema.safeParse(JSON.parse(body));
    if (!read.success) return unknown;
    const { rates } = read.data.data;
    if (!Object.hasOwn(rates, currency)) return { ok: false, listed: false };
    const rate = rates[currency] ?? "";
    if (!/^\d+(?:\.\d+)?$/.test(rate) || !/[1-9]/.test(rate)) return unknown;
    return {
      ok: true,
      rate,
      source: REFERENCE_SOURCE,
      readAt: (parts.now ?? (() => new Date()))(),
    };
  } catch {
    return unknown;
  } finally {
    clearTimeout(late);
  }
};
