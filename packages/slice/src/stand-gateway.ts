/**
 * The merchant-key calls the SDK does not carry: cards, receipts and the two
 * selling switches, which are dashboard operations the SDK deliberately lacks.
 * Addresses come from the contract's route table, so they cannot drift into a
 * second surface. Nothing the SDK does carry belongs here; an order list built
 * by hand beside `client.orders.list` would teach an outside engineer to do the
 * same.
 *
 * The fetch is handed in rather than taken from the global because the console
 * records what crosses its edges by wrapping it. A call that reached around it
 * would leave only its answer in the log, which reads as a log out of order
 * rather than one missing a half.
 */

import {
  API_ROUTES,
  expandPath,
  MERCHANT_KEY_HEADER,
  merchantKeyHeaderValue,
  type RouteDefinition,
} from "@nuanu-ai/agentify-contracts";

export interface GatewayAnswer {
  readonly status: number;
  readonly body: unknown;
}

/** Everything one of these calls needs to know about where it is going. */
export interface Reach {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** The fetch the console watches its own edges through. */
  readonly fetch: typeof fetch;
}

const call = async (
  reach: Reach,
  route: RouteDefinition,
  values: Readonly<Record<string, string>> = {},
): Promise<GatewayAnswer> => {
  const response = await reach.fetch(
    `${reach.baseUrl.replace(/\/+$/, "")}${expandPath(route.path, values)}`,
    {
      method: route.method,
      headers: { [MERCHANT_KEY_HEADER]: merchantKeyHeaderValue(reach.apiKey) },
    },
  );
  const text = await response.text();

  try {
    return { status: response.status, body: text === "" ? null : JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
};

export const listCards = (reach: Reach): Promise<GatewayAnswer> =>
  call(reach, API_ROUTES.list_merchant_cards);

export const pauseCard = (reach: Reach, itemId: string): Promise<GatewayAnswer> =>
  call(reach, API_ROUTES.pause_card, { item_id: itemId });

export const resumeCard = (reach: Reach, itemId: string): Promise<GatewayAnswer> =>
  call(reach, API_ROUTES.resume_card, { item_id: itemId });

export const pauseSelling = (reach: Reach): Promise<GatewayAnswer> =>
  call(reach, API_ROUTES.pause_selling);

export const resumeSelling = (reach: Reach): Promise<GatewayAnswer> =>
  call(reach, API_ROUTES.resume_selling);

export const listReceipts = (reach: Reach): Promise<GatewayAnswer> =>
  call(reach, API_ROUTES.list_receipts);
