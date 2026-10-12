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
 * pass the outcome to `answer`; its component draws a screen from
 * `app/screens/`, which is a function of a view and is tested by drawing it.
 * Every form behind the gate is a `PostForm`. Route modules import nothing at
 * run time from `src/` but `drawn-for.ts`, which imports nothing itself, so the
 * browser's build carries no schema library and no copy of the server; types
 * may be imported from anywhere.
 *
 * Tests answer these routes from source, compiled by Vite in middleware mode
 * (`src/testing/pages.ts`), so `pnpm test` builds nothing first.
 */

import { layout, type RouteConfig, route } from "@react-router/dev/routes";

export default [
  route("sign-in", "routes/sign-in.tsx"),
  route("sign-in/open", "routes/sign-in-open.tsx"),
  route("sign-out", "routes/sign-out.ts"),
  layout("routes/gate.tsx", [
    layout("routes/merchant-only.tsx", [
      route("cards", "routes/cards.tsx"),
      route("orders", "routes/orders.tsx"),
      route("receipts", "routes/receipts.tsx"),
    ]),
  ]),
] satisfies RouteConfig;
