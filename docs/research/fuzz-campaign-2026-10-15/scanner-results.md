# Scanner second-wave inventory

Date: 2026-10-15. Product subject:
`e11fef741e875ef6f9c42465a6b27577dd2921a1`. The selected integration run executes
on campaign HEAD `f1ca8e19d56600ecdcc696975137707b8bcaaad5`. A source diff against
the subject is empty for `apps/web`, `apps/browser-observer-actor`,
`packages/scanner`, `packages/scanner-contracts` and `packages/scanner-database`.
This work changes no product or test files, deploys nothing and scans no
external site.

The inventory finds 55 declarations in `apps/web/app/routes.ts`: 27 API route
templates, 27 other concrete route templates, and the wildcard 404. Parameter
templates are counted once, regardless of how many identifiers they admit.
Assets and React Router's generated data/manifest requests are not additional
declared routes in that count. The scanner's routes are distinct from the
commerce gateway and merchant dashboard routes.

## Fresh execution

The single selected existing integration command is:

```sh
pnpm exec vitest run --project integration apps/browser-observer-actor/src/actor.integration.test.ts --maxWorkers=1
```

All seven tests pass in 8.28 seconds according to Vitest; the outer harness
finishes in 8.830 seconds with exit 0 inside its 120-second wall budget.
[scanner-integration.txt](scanner-integration.txt) preserves the command and
actual runner output. The file uses real Chromium with local HTML fixtures
and an injected resource reader, plus a loopback UDP listener. Its page URLs
are fixture identifiers; the resource reader supplies the responses rather
than contacting those domains. No service, database or browser installation
is bootstrapped.

The seven assertions cover rendered aggregate extraction, main-frame and
iframe runtime guards, blocked popups, keeping raw/rendered comparisons tied
to the main document, cancellation of an unfinished resource after return,
recovery to later pages after a nonyielding script, and truthful timeout
classification for a page that never finishes loading. This is fresh browser
observer evidence, not a fresh run of the scanner HTTP routes or database
flows.

The campaign's consolidated unit run is already recorded in
[report.md](report.md): 5,903 total, 5,887 passing and sixteen skipped, including
twelve expected failures in commerce checks. It is not rerun here. The source
mapping below describes existing assertions, not additional generated cases.

## API route inventory and existing coverage

Paths below have a leading `/`. Test files are under
`apps/web/app/routes/api/` unless a different root is stated. Those API unit
files ask the scanner's actual source server over an ephemeral loopback HTTP
port through `apps/web/testing/scanner.ts`. They intentionally use an absent
database/dashboard for decisions made before persistence. Consequently a
passing refusal does not establish the corresponding authorized write.

All API modules use `lib/server/methods.ts`: GET supports HEAD, OPTIONS names
the declared methods, and unsupported ordinary methods return 405. The table
names explicit application methods; HEAD and OPTIONS are implicit. Existing
test files assert method behavior for the route families, with liveness and
private-state HEAD examples. This is not a complete method-by-route matrix.

| Path | Method | Existing deterministic assertions | Existing integration beyond the gate, not executed here |
| --- | --- | --- | --- |
| `/api/health` | GET | `api.test.ts`: unavailable database is 503 and worker state remains unknown. | `apps/web/server/start.integration.test.ts`: fake PostgreSQL readiness and idle-connection loss. |
| `/api/health/live` | GET | `api.test.ts`: valid/invalid configuration, request ID, no-store, HEAD, unsupported method and OPTIONS. | `apps/web/server/start.integration.test.ts`: built process liveness and shutdown. |
| `/api/v1/account/data-request` | POST | `v1/account.test.ts`: foreign origin, signed-out visitor, unknown identity, method. | P4/P5: persisted request/deletion and terminal identity cleanup. |
| `/api/v1/account/unsubscribe` | POST | `v1/account.test.ts`: foreign origin, signed-out visitor, unknown identity, method. | P4/P5: retained person and consent/deletion behavior. |
| `/api/v1/attribution` | POST | `v1/measurement.test.ts`: unknown fields/segment, unsuitable touch data, absent visitor, unavailable database, method. | P4: consent-controlled persistence and attribution neutrality. |
| `/api/v1/card-signals/setup-intents` | POST | `v1/card-signals.test.ts`: origin, idempotency key, consent/scan shape, feature off, signed-out visitor, method. | P5: local Stripe adapter setup and privacy cleanup. |
| `/api/v1/card-signals/:signalId` | GET | `v1/card-signals.test.ts`: signed-out visitor, unknown identity and method. | P5: owned signal and provider state. |
| `/api/v1/card-signals/:signalId/local-confirm` | POST | `v1/card-signals.test.ts`: signed-out visitor, unknown identity, foreign origin and method. | No fresh HTTP success evidence; local provider logic has unit coverage. |
| `/api/v1/card-signals/:signalId/payment-method` | DELETE | `v1/card-signals.test.ts`: signed-out visitor, unknown identity, foreign origin and method. | P5: detach and provider readback during deletion. |
| `/api/v1/consent` | POST | `api.test.ts`: absent/foreign origin, malformed JSON, policy mismatch, forbidden/extra fields, database failure without cookie, method. | P4: saved consent and measurement behavior. |
| `/api/v1/events` | POST | `v1/measurement.test.ts`: origin, unknown event, missing/invalid ID/context, absent authority, unknown visitor, method. | P4: consent-controlled recording. |
| `/api/v1/reports/:scanId` | GET | `v1/reports.test.ts`: unsigned visitor, unknown identity, method. | P4: owner's complete 18-check report. |
| `/api/v1/reports/:scanId/remediation-prompt` | GET | `v1/reports.test.ts`: feature/identity gates, full-scope enforcement and method. | P4 covers report/prompt ownership; no fresh full prompt HTTP success. |
| `/api/v1/reports/:scanId/remediation-prompt/download` | GET | `v1/reports.test.ts`: feature/identity gates, full-scope enforcement and method. | P4: authorized full prompt download. |
| `/api/v1/scans` | POST | `v1/scans.test.ts`: origin, paused admission, key length, malformed JSON/URL, missing segment, disallowed port, replay lookup/database/limit failures, method. | P4: admission/replay, cookie, queue atomicity and rolling rate windows. |
| `/api/v1/scans/:id/browser-observation` | GET | `v1/scans.test.ts`: bearer gate, disabled observation mode, methods. | Fresh actor fixture run checks observation generation, not this HTTP response. |
| `/api/v1/scans/:id/remediation-prompt` | GET | `v1/reports.test.ts`: feature/token gates, teaser-scope enforcement, unknown identity, method. | P4: teaser access and prompt contents. |
| `/api/v1/scans/:id/remediation-prompt/download` | GET | `v1/reports.test.ts`: feature/token gates, teaser-scope enforcement, unknown identity, method. | P4: teaser download and full-scope refusal. |
| `/api/v1/scans/:id/share` | POST | `v1/scans.test.ts`: origin, malformed request, missing authority, unknown identity, method. | P4: owned publication, safe snapshot and revocation. |
| `/api/v1/scans/:id/share-preview` | GET | `share-preview.test.ts`: absent authority, unknown identity and method. | P4: exact preview and existing published share. |
| `/api/v1/scans/:id/status` | GET | `v1/scans.test.ts`: bearer gate, HEAD refusal, method. | P4: persisted state/status and queue replay. |
| `/api/v1/shares/:slug` | DELETE | `v1/scans.test.ts`: origin and method. | P4: authorized revocation through reporting service. |
| `/api/v1/shares/:slug/image` | GET | No direct HTTP assertion found in the nine API unit files. `lib/server/share-image.test.ts` checks image content/rendering separately. | P4 invokes the actual route with a persisted share and checks PNG output. |
| `/api/v1/webhooks/stripe` | POST | `v1/card-signals.test.ts`: raw-byte signature acceptance reaches records, altered bytes/missing signature do not, method. | P5: local provider webhook and deduplication-related persisted behavior. |
| `/api/v2/scans/:id/contact-access` | GET | `v2/session.test.ts`: unverified versus unknown visitor and method. | P4: contact ownership and verified access. |
| `/api/v2/scans/:id/registrations` | POST | `v2/scans.test.ts`: origin, disabled registration, bearer requirement and method. | P4: email normalization/binding, once across tabs, wrong/stale session, delivery uncertainty, expiry and cooldown. |
| `/api/v2/session` | GET | `v2/session.test.ts`: signed-out versus unknown visitor, private cache and method. | P4: signed-in identity, operator flag, session renewal and cookie isolation. |

P4 and P5 refer to `apps/web/lib/server/p4.integration.test.ts` and
`p5.integration.test.ts`. They require a dedicated `*_migration_test` database
and drop/recreate schemas. Their dashboard/email/Stripe boundaries are local
fixtures, but their database is a real external prerequisite; they are not
run or bootstrapped by this task.

Schema coverage also exists in
`packages/scanner-contracts/src/required-fields.test.ts`: explicit valid
documents and deletion of each enumerated required field, including nested
paths, must yield a field-specific nonempty issue. `contracts.test.ts` adds
URL, UUIDv7, phone normalization, report/share shapes and bounded browser
observation contracts. These cases do not enumerate every scalar, length,
Unicode, time or cross-field combination.

## Other public HTTP declarations

These 27 concrete templates and the fallback are registered by the same web
process. Pages are read with GET/HEAD; the three redirect modules also
explicitly redirect POST. Resource modules use the same method wrapper as the
API. Admin refuses nonoperators before displaying anything and rejects an
operator's POST with 405.

| Routes | Existing evidence and boundary |
| --- | --- |
| `/`, `/store`, `/local` | `app/routes/pages.test.ts`: source-server HTML, scan offering, segment/variant, metadata and banner. |
| `/owner`, `/methodology`, `/scanner` | `pages.test.ts`: permanent uncached redirects; scanner/docs redirect preserves query, including HEAD/POST/Markdown requests. |
| `/privacy`, `/terms` | `pages.test.ts`: policy HTML, configured contacts, metadata, crawler intent and links. |
| `/agentic-shop`, `/agentic-shop/privacy`, `/sell` | `agentic-shop.test.ts`, `sell.test.ts`: declared content, dashboard entry, privacy notice, metadata and unsupported forms. |
| `/data-request`, `/email/unsubscribe` | `account-pages.test.ts`: private metadata, no usable action before identity lookup, privacy contact; request authority is separately covered by API tests. |
| `/opengraph-image`, `/agentic-shop/opengraph-image`, `/apple-icon`, `/icon.svg` | `icons.test.ts`, `agentic-shop.test.ts`, `server/answers.test.ts` and image renderer tests cover format, dimensions/links, methods and headers. Built-process image availability is a separate unexecuted start suite. |
| `/manifest.webmanifest`, `/robots.txt`, `/llms.txt`, `/sitemap.xml` | `icons.test.ts`, `crawlers.test.ts`: referenced icon types, public/crawler lists, metadata and cache behavior. |
| `/scan/pending`, `/scan/:id` | `scan.test.ts`: private progress HTML, challenge key, feature switches and nonproduction fixtures. Persisted progress is outside these HTML assertions. |
| `/report/latest`, `/report/:scanId` | `report.test.ts`, `report.latest.test.ts`: signed-out/unknown identity, latest selection and private metadata; P4 supplies persisted ownership cases. |
| `/s/:slug` | Public share HTML route exists; no direct request-level unit assertion found. P4 validates the underlying snapshot/public URL and image route, which does not prove this page's rendering. |
| `/admin` | `lib/server/operator.test.ts` covers identity logic. `admin-door.integration.test.ts` covers built HTTP page/data/script refusal, revocation and outage, but requires a build and dedicated migration database and is not executed here. |
| `*` | `server/answers.test.ts`: missing/malformed/encoded addresses, 404, method handling, slash normalization, cache/Markdown boundaries and sanitized whole-request failures. |

`server/answers.test.ts` and `process-headers.test.ts` additionally exercise
cross-cutting headers and process behavior. `server/in-chromium.integration.test.ts`
contains hydration/navigation/banner/focus and simulated edge-route tests, but
it requires a built web bundle and Chromium. The web bundle is absent in this
worktree. Neither that suite nor the standalone built-process suite is run.

## Remaining dimensions and conclusion

The fresh seven-case integration run finds no failure. The inventory alone
does not establish a scanner defect. It also cannot claim complete scanner
acceptance. The following dimensions remain unexecuted in this second wave:

* Database-backed accepted scan/report/share/registration/consent/card-signal
  operations, their concurrent interleavings, and retention/identity deletion.
  Existing P4/P5 cases are mapped above; their presence is not execution.
* End-to-end scan dispatch, fetch policy, ordinary scanner worker completion,
  browser actor ingestion and persisted report/status agreement. No external
  target is scanned.
* Public share HTML, route-wide authenticated image success, operator HTTP
  access and the compiled process's image/startup behavior.
* Live dashboard identity, real email delivery/links, Stripe provider traffic,
  Turnstile and analytics delivery. Local doubles and signature checks cannot
  prove their live contracts.
* A scanner-specific generated body/error/boundary matrix across all routes,
  every required field at the HTTP layer, scale growth, truncation, repeated
  delivery and browser recovery. Existing examples cover selected classes;
  no exhaustive, pairwise or fuzz-case count is assigned to the inventory.

The commerce campaign's API, wallet, SDK and WooCommerce counts therefore
remain separate. Scanner evidence consists of an inspected route/test mapping,
the already-recorded consolidated unit regression run, and seven freshly
passing local browser observer integration tests.
