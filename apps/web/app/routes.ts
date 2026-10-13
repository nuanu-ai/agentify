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
  at("admin", "routes/admin.tsx"),
  at("methodology", "routes/methodology.tsx"),
  at("data-request", "routes/data-request.tsx"),
  at("email/unsubscribe", "routes/email.unsubscribe.tsx"),
  at("opengraph-image", "routes/opengraph-image.ts"),
  at("agentic-shop/opengraph-image", "routes/agentic-shop.opengraph-image.ts"),
  at("apple-icon", "routes/apple-icon.ts"),
  at("icon.svg", "routes/icon.svg.ts"),
  at("manifest.webmanifest", "routes/manifest.webmanifest.ts"),
  at("robots.txt", "routes/robots.txt.ts"),
  at("llms.txt", "routes/llms.txt.ts"),
  at("sitemap.xml", "routes/sitemap.xml.ts"),
  at("s/:slug/opengraph-image", "routes/s.slug.opengraph-image.ts"),
  at("api/health", "routes/api/health.ts"),
  at("api/health/live", "routes/api/health.live.ts"),
  at("api/v1/account/data-request", "routes/api/v1/account.data-request.ts"),
  at("api/v1/account/unsubscribe", "routes/api/v1/account.unsubscribe.ts"),
  at("api/v1/attribution", "routes/api/v1/attribution.ts"),
  at("api/v1/card-signals/setup-intents", "routes/api/v1/card-signals.setup-intents.ts"),
  at("api/v1/card-signals/:signalId", "routes/api/v1/card-signals.signalId.ts"),
  at(
    "api/v1/card-signals/:signalId/local-confirm",
    "routes/api/v1/card-signals.signalId.local-confirm.ts",
  ),
  at(
    "api/v1/card-signals/:signalId/payment-method",
    "routes/api/v1/card-signals.signalId.payment-method.ts",
  ),
  at("api/v1/consent", "routes/api/v1/consent.ts"),
  at("api/v1/events", "routes/api/v1/events.ts"),
  at("api/v1/reports/:scanId", "routes/api/v1/reports.scanId.ts"),
  at(
    "api/v1/reports/:scanId/remediation-prompt",
    "routes/api/v1/reports.scanId.remediation-prompt.ts",
  ),
  at(
    "api/v1/reports/:scanId/remediation-prompt/download",
    "routes/api/v1/reports.scanId.remediation-prompt.download.ts",
  ),
  at("api/v1/scans", "routes/api/v1/scans.ts"),
  at("api/v1/scans/:id/browser-observation", "routes/api/v1/scans.id.browser-observation.ts"),
  at("api/v1/scans/:id/registrations", "routes/api/v1/scans.id.registrations.ts"),
  at("api/v1/scans/:id/remediation-prompt", "routes/api/v1/scans.id.remediation-prompt.ts"),
  at(
    "api/v1/scans/:id/remediation-prompt/download",
    "routes/api/v1/scans.id.remediation-prompt.download.ts",
  ),
  at("api/v1/scans/:id/share", "routes/api/v1/scans.id.share.ts"),
  at("api/v1/scans/:id/share-preview", "routes/api/v1/scans.id.share-preview.ts"),
  at("api/v1/scans/:id/status", "routes/api/v1/scans.id.status.ts"),
  at("api/v1/shares/:slug", "routes/api/v1/shares.slug.ts"),
  at("api/v1/shares/:slug/image", "routes/api/v1/shares.slug.image.ts"),
  at("api/v1/webhooks/stripe", "routes/api/v1/webhooks.stripe.ts"),
  at("api/v2/scans/:id/contact-access", "routes/api/v2/scans.id.contact-access.ts"),
  at("api/v2/scans/:id/registrations", "routes/api/v2/scans.id.registrations.ts"),
  at("api/v2/session", "routes/api/v2/session.ts"),
  at("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
