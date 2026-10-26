/**
 * The dashboard's pages. Every path under it matches one of these, the last of
 * them the page that says there is no such page.
 *
 * A page that shows anything of an account goes under the gate, and one about
 * a merchant's selling under `merchant-only` as well. What stands outside the
 * gate answers the same to everybody, and a test holds the list.
 *
 * A route module's loader and action read what the request carried, call its
 * server half in `src/page-services.ts` through the `services` context, and
 * pass the outcome to `answer` with their own arguments; its component draws a
 * screen from `app/screens/`, which is a function of a view and is tested by
 * drawing it. The page's address is `url`, never `request.url`: React Router 8
 * hands a loader the request as it arrived, and a data request's address
 * carries `.data` and `_routes`.
 * Every form behind the gate is a `PostForm`. Route modules import nothing at
 * run time from `src/` but `drawn-for.ts`, which imports nothing itself, so the
 * browser's build carries no schema library and no copy of the server; types
 * may be imported from anywhere.
 *
 * Tests answer these routes from source, compiled by Vite in middleware mode
 * (`src/testing/pages.ts`), so `pnpm test` builds nothing first.
 */

import { index, layout, type RouteConfig, route } from "@react-router/dev/routes";

export default [
  route("sign-in", "routes/sign-in.tsx"),
  route("sign-in/open", "routes/sign-in-open.tsx"),
  route("sign-in/google", "routes/sign-in-google.tsx"),
  route("sign-in/google/callback", "routes/sign-in-google-callback.tsx"),
  route("sign-out", "routes/sign-out.ts"),
  route("woocommerce/return", "routes/woocommerce-return.tsx"),
  layout("routes/gate.tsx", [
    index("routes/start.ts"),
    route("merchant", "routes/merchant.tsx"),
    // The operator's workspace: the layout answers only an account the
    // operator flag confirms, before any page under it runs.
    layout("routes/admin/only.tsx", [
      route("admin", "routes/admin/index.tsx"),
      route("admin/merchants", "routes/admin/merchants.tsx"),
      route("admin/merchants/:merchant_id", "routes/admin/merchant.tsx"),
      route("admin/merchants/:merchant_id/admit", "routes/admin/merchant-admit.tsx"),
      route("admin/merchants/:merchant_id/withdraw", "routes/admin/merchant-withdraw.tsx"),
      route(
        "admin/merchants/:merchant_id/keys/:key_id/disable",
        "routes/admin/merchant-key-disable.tsx",
      ),
      route("admin/orders", "routes/admin/orders.tsx"),
      route("admin/orders/:order_id", "routes/admin/order.tsx"),
      route("admin/find", "routes/admin/find.tsx"),
      route("admin/money", "routes/admin/money.tsx"),
      route("admin/health", "routes/admin/health.tsx"),
      route("admin/accounts", "routes/admin/accounts.tsx"),
      route("admin/accounts/:account_id", "routes/admin/account.tsx", [
        // One address per action, all answered by one module.
        ...(["end-sessions", "grant-operator", "remove-operator", "forget"] as const).map((act) =>
          route(act, "routes/admin/account-press.tsx", { id: `routes/admin/account-${act}` }),
        ),
      ]),
      route("admin/journal", "routes/admin/journal.tsx"),
      route("admin/sign-in-again", "routes/admin/sign-in-again.tsx"),
      route("admin/*", "routes/admin/no-such-page.tsx"),
    ]),
    layout("routes/merchant-only.tsx", [
      route("choose-name", "routes/choose-name.tsx"),
      route("products", "routes/products.tsx"),
      route("orders", "routes/orders.tsx"),
      route("receipts", "routes/receipts.tsx"),
      route("integrations", "routes/integrations.tsx"),
      route("settings", "routes/settings.tsx", [
        route("site", "routes/settings-site.ts"),
        route("sign-out-everywhere", "routes/settings-sign-out-everywhere.ts"),
        route("analytics", "routes/settings-analytics.ts"),
        route("payout-wallet/cancel", "routes/settings-payout-wallet-cancel.ts"),
      ]),
      route("settings/payout-wallet", "routes/settings-payout-wallet.tsx"),
      route("keys", "routes/keys.tsx"),
      route("keys/:key_id/disable", "routes/keys-disable.ts"),
      route("woocommerce", "routes/woocommerce.tsx"),
      route("integrations/woocommerce/recover/:order_id", "routes/woocommerce-recovery.tsx"),
      layout("routes/woocommerce-presses.tsx", [
        route("woocommerce/connect", "routes/woocommerce-connect.tsx"),
        route("woocommerce/import", "routes/woocommerce-import.tsx"),
        route("woocommerce/rate", "routes/woocommerce-rate.tsx"),
        route("woocommerce/switch", "routes/woocommerce-switch.tsx"),
        route("woocommerce/disconnect", "routes/woocommerce-disconnect.tsx"),
      ]),
      route("*", "routes/no-such-page.tsx"),
    ]),
  ]),
] satisfies RouteConfig;
