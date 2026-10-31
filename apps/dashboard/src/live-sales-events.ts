import type { LiveSalesChange, LiveSalesNotice } from "@agentify/gateway/live-sales";
import type { ShopJob } from "./shop-jobs.js";

export type RequestMailEvent = Omit<LiveSalesNotice, "kind"> & {
  readonly kind: LiveSalesNotice["kind"] | "reminder";
};
export interface PublicationResult {
  readonly at: number;
  readonly host: string;
  readonly status: "completed" | "stopped";
  readonly published: number;
  readonly fix: number;
  readonly read: number;
  readonly total: number | null;
  readonly stopCode: ShopJob["stopCode"];
  readonly why: string | null;
}
export interface DecisionMailEvent extends Omit<LiveSalesChange, "kind"> {
  readonly kind: "admitted" | "published" | "withdrawn";
  readonly next: "wallet" | "code" | "settings" | "connect" | "products";
  readonly publication: PublicationResult | null;
}
export type LiveSalesMailEvent = RequestMailEvent | DecisionMailEvent;
export const operatorMail = (kind: LiveSalesMailEvent["kind"]) =>
  kind === "requested" || kind === "reminder";
export const eventMerchant = (event: LiveSalesMailEvent) =>
  "request" in event ? event.request.merchantId : event.merchantId;
export const eventId = (event: LiveSalesMailEvent) =>
  "request" in event ? event.request.id : event.id;
