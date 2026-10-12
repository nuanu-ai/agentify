/**
 * The pages React Router draws. The process answers a path with these only
 * where a route here matches it, and hands every other path to the pages still
 * drawn as strings; a screen moves by being added here and deleted there in
 * the same change.
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
  route("sign-out", "routes/sign-out.ts"),
  layout("routes/gate.tsx", [
    index("routes/start.ts"),
    route("merchant", "routes/merchant.tsx"),
    layout("routes/merchant-only.tsx", [
      route("choose-name", "routes/choose-name.tsx"),
      route("cards", "routes/cards.tsx"),
      route("orders", "routes/orders.tsx"),
      route("receipts", "routes/receipts.tsx"),
      route("integrations", "routes/integrations.tsx"),
      route("settings", "routes/settings.tsx", [
        route("site", "routes/settings-site.ts"),
        route("sign-out-others", "routes/settings-sign-out-others.ts"),
        route("payout-wallet/cancel", "routes/settings-payout-wallet-cancel.ts"),
      ]),
      route("settings/payout-wallet", "routes/settings-payout-wallet.tsx"),
    ]),
  ]),
] satisfies RouteConfig;
