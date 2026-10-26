/**
 * The dashboard's HTTP surface. Every page is drawn by React Router through
 * `pages.ts`, which also serves the built scripts and styles. What stands
 * beside the pages is short: the health probe, and the shop's callback, which
 * the shop's own server posts to. Both answer the same thing to everybody and
 * stand in front of the pages, whose gate would send their callers to the
 * sign-in. Nothing here decides anything about a card, an order or money: the
 * pages' server half translates each request into calls on the gateway's
 * application, as the merchant on the signed-in account's row.
 */

import type { Gateway } from "@agentify/gateway";
import type { OperatorReader } from "@agentify/gateway/operator";
import { classifyHttpRoute, telemetry } from "@agentify/observability/source";
import express, { type Express, type Request, type Response } from "express";
import type { AccountsDirectory } from "./admin/accounts.js";
import { type WorkspaceDoor, workspaceDoorFor } from "./admin/index.js";
import type { DashboardJournal } from "./admin/journal.js";
import type { DashboardConfig } from "./config.js";
import type { DashboardIdentity } from "./dashboard-entry.js";
import {
  type Acting,
  type GatewayClient,
  gatewayFor,
  type Registrar,
  registrarFor,
} from "./gateway.js";
import type { Postman } from "./mail.js";
import { pageServicesFor } from "./page-services.js";
import { type Pages, pagesHandler } from "./pages.js";
import { printable } from "./printable.js";
import { type ShopCalls, wooPagesFor } from "./woo-pages.js";
import type { WooShops } from "./woo-shops.js";

export interface DashboardParts {
  /** The pages, built ahead of time in a deployment or compiled from source. */
  readonly pages: Pages;
  /**
   * `identity.ts` over Postgres in a deployment, over the component's memory
   * store in tests, so the suite drives the real component offline.
   */
  readonly identity: DashboardIdentity;
  /** Called in-process as the merchant on the signed-in account's row. */
  readonly gateway: Gateway;
  /**
   * Built per request from whoever is signed in, so two people signed into one
   * dashboard are two merchants. Only tests pass another, to get a refusal or a
   * call that never finishes. The deadline is the caller's because a wallet
   * change waits longer than a screen does (`WALLET_CHANGE_MS` in
   * `payout-wallet.ts`).
   */
  readonly clientFor?: (acting: Acting, answerWithinMs?: number) => GatewayClient;
  /**
   * Not a client method, because the person has no merchant yet to bind a
   * client to.
   */
  readonly registrar?: Registrar;
  /**
   * Absent means no WooCommerce screens at all rather than screens that fail: a
   * page offering to connect a shop it cannot write down would lose somebody's
   * keys.
   */
  readonly wooShops?: WooShops;
  /** Only tests pass another. */
  readonly shop?: ShopCalls;
  /** The connector's own messages; the dashboard's mail where absent, as a deployment leaves it. */
  readonly postman?: Postman;
  /**
   * What the operator's workspace reads and writes with: the reader across
   * merchants and the journal a dashboard action writes its row through.
   * Absent, the workspace is not built and every page of it answers as one
   * that is not there; nothing else in the dashboard is handed either.
   */
  readonly admin?: AdminDoorParts;
  /** Only tests pass another, to stand at a moment of their own. */
  readonly now?: () => Date;
}

export function buildApp(config: DashboardConfig, parts: DashboardParts): Express {
  const app = express();
  app.use((request, response, next) => {
    const routeClass = classifyHttpRoute(request.path);
    telemetry.observeHttp("dashboard", request, response, () =>
      routeClass === "asset"
        ? routeClass
        : typeof request.route?.path === "string"
          ? request.route.path
          : routeClass,
    );
    next();
  });
  const base = config.basePath;
  const identity = parts.identity;
  const clientFor =
    parts.clientFor ??
    ((acting: Acting, answerWithinMs?: number) =>
      gatewayFor(parts.gateway, acting, answerWithinMs));

  app.disable("x-powered-by");
  // No `trust proxy`: nothing reads the client's address, and express would put
  // a spoofable value behind `request.ip` and `request.secure` where nobody
  // reading a handler would doubt it.
  if (parts.pages.assets !== null) {
    app.use(parts.pages.assets.path, parts.pages.assets.handle);
  }

  // At BASE_PATH behind the shared origin, and at the root for a container
  // health check: a probe answering 404 reads as a dead process.
  for (const path of new Set(["/healthz", `${base}/healthz`])) {
    app.get(path, (_request, response) => {
      response.json({ ok: true });
    });
  }

  /**
   * In front of the gate because it must be: the shop's own server posts here
   * with no cookie or key of ours. What stands in for a session is the one-time token
   * the shop hands back as `user_id`, written when the merchant pressed
   * Connect, bound to their account and the shop they typed, and spent on
   * arrival. Without it anybody could put their own shop's keys on somebody
   * else's account.
   *
   * The status is the answer: WooCommerce deletes the key it minted when the
   * post fails (`class-wc-auth.php`, `maybe_delete_key`), so a refusal takes
   * the key back out of the shop, which is right for a token we do not
   * recognise. Nothing below answers 200 out of politeness. It parses its own
   * JSON body so a JSON parser is not run on every form post.
   */
  app.post(`${base}/woocommerce/callback`, express.json({ limit: "16kb" }), (request, response) => {
    void (async () => {
      const shops = parts.wooShops;
      if (shops === undefined) {
        response.status(404).json({ ok: false });
        return;
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const token = typeof body.user_id === "string" ? body.user_id : "";
      const consumerKey = typeof body.consumer_key === "string" ? body.consumer_key : "";
      const consumerSecret = typeof body.consumer_secret === "string" ? body.consumer_secret : "";
      const permissions = typeof body.key_permissions === "string" ? body.key_permissions : "";

      if (token === "" || consumerKey === "" || consumerSecret === "") {
        console.log("[dashboard] a WooCommerce callback arrived without the keys it has to carry");
        response.status(400).json({ ok: false });
        return;
      }

      // Consumed together with the connection write: a token that worked twice
      // would let anybody who saw one put a second shop's keys on the account,
      // and consuming first would let an older callback overwrite a newer
      // Connect in between.
      const connectedAt = new Date();
      const connection = await shops.connectFromGrant(
        token,
        { consumerKey, consumerSecret, permissions },
        connectedAt,
      );
      if (connection === null) {
        // One answer for a token nobody issued, one spent and one expired:
        // telling them apart would answer questions about somebody else's
        // account.
        console.log("[dashboard] a WooCommerce callback arrived with a token we do not hold");
        response.status(401).json({ ok: false });
        return;
      }

      // The address and the scope, never the keys: a log goes places the
      // database does not.
      console.log(
        printable(
          `[dashboard] a WooCommerce shop was connected for an account: ${connection.shopUrl}, ${permissions}`,
        ),
      );
      response.json({ ok: true });
    })().catch(() => {
      // A failure, so the shop takes its key back rather than keeping one
      // nothing here knows about. The exception is not logged: a failed write
      // carries the values it was given, the shop's secret among them.
      console.error("[dashboard] a WooCommerce callback could not be written down");
      if (!response.headersSent) {
        response.status(500).json({ ok: false });
      }
    });
  });

  app.use(
    pagesHandler(
      parts.pages,
      pageServicesFor(config, {
        ...(parts.admin === undefined
          ? {}
          : { workspace: workspaceDoorOver(config, parts, parts.admin) }),
        identity,
        clientFor,
        registrar: parts.registrar ?? registrarFor(parts.gateway),
        woo:
          parts.wooShops === undefined
            ? null
            : wooPagesFor(config, {
                identity,
                clientFor: (acting) => clientFor(acting),
                shops: parts.wooShops,
                ...(parts.shop === undefined ? {} : { shop: parts.shop }),
                ...(parts.postman === undefined ? {} : { postman: parts.postman }),
              }),
      }),
      config.cookieSecure,
    ),
  );

  // What no page takes, which `pages.ts` lists: these get no frame and no
  // gate, and say nothing about who is signed in.
  app.use((_request, response) => {
    response.status(404).type("text/plain").send("Not Found");
  });

  app.use(
    (thrown: unknown, _request: Request, response: Response, next: (error?: unknown) => void) => {
      if (response.headersSent) {
        next(thrown);
        return;
      }
      // The callback's parser refusing a body is the sender's doing, answered
      // to the shop's server under the parser's own status.
      const refused = refusedBody(thrown);
      if (refused !== null) {
        response.status(refused).json({ ok: false });
        return;
      }
      // A defect outside the pages, which draw their own. The exception is not
      // logged, because driver and provider exceptions can carry bound values,
      // session tokens and merchant keys among them.
      console.error("[dashboard] a request failed");
      response.status(500).type("text/plain").send("Something in the dashboard is broken.");
    },
  );

  return app;
}

/**
 * What the workspace reads and writes with beyond the dashboard's own parts:
 * the reader across merchants, the journal a dashboard action writes its row
 * through, and the accounts' operator-side reads and changes.
 */
type AdminDoorParts = Readonly<{
  reader: OperatorReader;
  journal: DashboardJournal;
  accounts: AccountsDirectory;
}>;

/**
 * The workspace's services, the one place the operator's reader is handed to:
 * every refused press is written to the journal through the gateway's store.
 */
function workspaceDoorOver(
  config: DashboardConfig,
  parts: DashboardParts,
  admin: AdminDoorParts,
): WorkspaceDoor {
  const now = parts.now ?? (() => new Date());
  const store = parts.gateway.runtime.store;
  return workspaceDoorFor({
    config,
    identity: parts.identity,
    gateway: parts.gateway,
    reader: admin.reader,
    journal: admin.journal,
    accounts: admin.accounts,
    now,
    shops: parts.wooShops ?? null,
    pressing: {
      now,
      googleEnabled: parts.identity.googleEnabled,
      refused: (entry) => store.recordJournal(entry),
    },
  });
}

/**
 * `body-parser` marks its own refusals with a `type` and a status below 500; a
 * status alone is not enough, since any exception can carry one.
 */
function refusedBody(thrown: unknown): number | null {
  if (typeof thrown !== "object" || thrown === null || !("type" in thrown)) return null;
  const status = (thrown as { status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 500 ? status : null;
}
