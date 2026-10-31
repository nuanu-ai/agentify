/** Gallery inputs call the delivery renderer; subject and HTML are shown together. */
import type { LiveSalesChange } from "@agentify/gateway/live-sales";
import type { DecisionMailEvent, PublicationResult } from "./live-sales-events.js";
import { liveSalesMessage } from "./live-sales-message.js";

const at = Date.parse("2026-10-30T14:00:00Z");
const change: LiveSalesChange = {
  kind: "admitted",
  id: "decision_gallery",
  merchantId: "mch_gallery",
  approvalAt: at,
  at,
  sellerName: "Freeland",
  sellerSite: "https://freeland.app",
  integration: "woocommerce",
  hasWallet: true,
  reason: null,
};
const complete: PublicationResult = {
  at: at + 120000,
  host: "woo.nuanu.ai",
  status: "completed",
  read: 100,
  total: 100,
  published: 72,
  fix: 3,
  stopCode: null,
  why: null,
};
const base: DecisionMailEvent = {
  ...change,
  kind: "admitted",
  next: "products",
  publication: complete,
};
const states: readonly {
  readonly id: string;
  readonly title: string;
  readonly event: DecisionMailEvent;
}[] = [
  { id: "admission-published", title: "Approval · shop published", event: base },
  {
    id: "admission-partial",
    title: "Approval · publication stopped",
    event: {
      ...base,
      publication: {
        ...complete,
        status: "stopped",
        read: 40,
        published: 27,
        stopCode: "interrupted",
      },
    },
  },
  {
    id: "admission-unread",
    title: "Approval · shop unread",
    event: {
      ...base,
      publication: {
        ...complete,
        status: "stopped",
        read: 0,
        total: null,
        published: 0,
        fix: 0,
        stopCode: "unread",
      },
    },
  },
  {
    id: "admission-shop-wallet",
    title: "Approval · shop needs wallet",
    event: { ...base, hasWallet: false, next: "wallet", publication: null },
  },
  {
    id: "admission-code-wallet",
    title: "Approval · code needs wallet",
    event: { ...base, integration: "api", hasWallet: false, next: "wallet", publication: null },
  },
  {
    id: "admission-code",
    title: "Approval · publish from code",
    event: { ...base, integration: "api", next: "code", publication: null },
  },
  {
    id: "wallet-published",
    title: "First wallet · shop published",
    event: { ...base, kind: "published" },
  },
  {
    id: "wallet-partial",
    title: "First wallet · publication stopped",
    event: {
      ...base,
      kind: "published",
      publication: {
        ...complete,
        status: "stopped",
        read: 40,
        published: 27,
        stopCode: "interrupted",
      },
    },
  },
  {
    id: "wallet-unread",
    title: "First wallet · shop unread",
    event: {
      ...base,
      kind: "published",
      publication: {
        ...complete,
        status: "stopped",
        read: 0,
        total: null,
        published: 0,
        fix: 0,
        stopCode: "unread",
      },
    },
  },
  {
    id: "withdrawn",
    title: "Live sales withdrawn",
    event: {
      ...base,
      kind: "withdrawn",
      next: "products",
      publication: null,
      reason: "Use the seller name buyers know.\nCorrect the name, then ask again.",
    },
  },
  {
    id: "admission-settings",
    title: "Manual approval · seller settings missing",
    event: { ...base, sellerName: null, next: "settings", publication: null },
  },
  {
    id: "admission-connect",
    title: "Manual approval · connection missing",
    event: { ...base, next: "connect", publication: null },
  },
  {
    id: "admission-choose",
    title: "Manual approval · several shops connected",
    event: { ...base, next: "choose", publication: null },
  },
  ...(["admitted", "published"] as const).flatMap((kind) => [
    {
      id: `${kind}-check-needed`,
      title:
        kind === "admitted"
          ? "Approval · check needs attention"
          : "First wallet · check needs attention",
      event: { ...base, kind, next: "products" as const, publication: null },
    },
    ...(kind === "published"
      ? [
          {
            id: "wallet-settings",
            title: "First wallet · seller settings missing",
            event: {
              ...base,
              kind,
              sellerName: null,
              next: "settings" as const,
              publication: null,
            },
          },
          {
            id: "wallet-connect",
            title: "First wallet · connection missing",
            event: { ...base, kind, next: "connect" as const, publication: null },
          },
          {
            id: "wallet-zero",
            title: "First wallet · no products confirmed for sale",
            event: { ...base, kind, publication: { ...complete, published: 0 } },
          },
        ]
      : []),
  ]),
  {
    id: "admission-zero",
    title: "Approval · complete publication with no products on sale",
    event: { ...base, publication: { ...complete, published: 0 } },
  },
  {
    id: "admission-unknown-total",
    title: "Approval · stopped with unknown total",
    event: {
      ...base,
      publication: {
        ...complete,
        status: "stopped",
        read: 40,
        total: null,
        published: 27,
        stopCode: "unknown",
      },
    },
  },
];
export const liveSalesAdmissionStates = states.map(({ id, title, event }) => ({
  id,
  title,
  ...liveSalesMessage({
    to: "merchant@example.com",
    event,
    requesterEmail: null,
    baseUrl: "https://agentify.ad/dashboard",
    idempotencyKey: `gallery-${id}`,
  }),
}));
