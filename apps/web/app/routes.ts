/**
 * The scanner's addresses, pages and API alike. Every path matches one of
 * these, the last of them the page that says there is no such page, which is
 * answered with status 404.
 *
 * A page is a route module under `routes/` named after its address
 * (`/methodology` is `routes/methodology.tsx`): its `loader` reads what the
 * request carried and returns what the page shows, its `meta` builds the head
 * with `pageMeta`, and its component draws from the loader's data, never from
 * the environment or the server's modules, because it is drawn again in the
 * browser. A loader says a page does not exist with
 * `throw data(null, { status: 404 })`, and sends the visitor elsewhere with
 * `throw redirect(to, { status, headers })`, naming the status, since React
 * Router's own is 302, and any `Cache-Control`, since a redirect is answered
 * before a page is drawn and carries only what it says.
 *
 * An API route is a module under `routes/api/` named after its path, a
 * parameter written as its name (`/api/v1/scans/:id/status` is
 * `routes/api/v1/scans.id.status.ts`), whose `loader` and `action` are both
 * what `methods` in `lib/server/methods.ts` makes of its handlers, which
 * answers `HEAD`, `OPTIONS` and an unsupported method the way every API route
 * does. React Router refuses a destructured route export, so each is its own
 * `export const`.
 *
 * A page that is the same for everybody is listed in
 * `content/public-page-metadata.ts`, which is what lets a shared cache keep it,
 * offers it as Markdown and has links to it fetched ahead of a click; a page
 * under `/scan` or `/report` is kept by nobody (`lib/server/answer-headers.ts`).
 *
 * Every route is matched with its case, as a request spells it.
 *
 * Tests ask the whole process over HTTP, compiled from source on each run
 * (`testing/scanner.ts`), so `pnpm test` builds nothing first; a component is
 * drawn on its own under the router with `testing/on-site.tsx`.
 */

import { index, type RouteConfig, route } from "@react-router/dev/routes";

const at = (path: string, file: string) => route(path, file, { caseSensitive: true });

export default [
  index("routes/home.tsx"),
  at("methodology", "routes/methodology.tsx"),
  at("report/latest", "routes/report.latest.tsx"),
  at("s/:slug", "routes/s.slug.tsx"),
  at("api/health", "routes/api/health.ts"),
  at("api/health/live", "routes/api/health.live.ts"),
  at("api/v1/consent", "routes/api/v1/consent.ts"),
  at("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
