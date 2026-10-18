/**
 * The scanner's pages in the states a person can meet them in, for the gallery
 * (`pnpm gallery`). Each state is drawn through the route tree `routes.ts`
 * declares, at its address, in the body every page is drawn in, with the data
 * its loader would have returned: the page's own content where its loader
 * reads nothing else, and views the real view functions build from example
 * data where it reads the database. A state only the page's script reaches,
 * a scan's progress or an answer to a press, is drawn with a scene: what the
 * tab holds and what the site answers the page's requests with. Nothing here
 * runs on the site; `gallery.test.tsx` holds that every page the route table
 * declares has a state here.
 */

import { createHash } from "node:crypto";
import { BannerAnswered } from "@agentify/consent";
import type { BrowserScene, GalleryState, GallerySurface } from "@agentify/gallery";
import { levelForScore } from "@agentify/scanner";
import {
  type BrowserObservationStatusResponse,
  CHECK_DEFINITIONS,
  type ReportResponse,
  type ScanStatusResponse,
} from "@agentify/scanner-contracts";
import type { RouteConfigEntry } from "@react-router/dev/routes";
import type { ComponentType, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createRoutesStub,
  UNSAFE_ErrorResponseImpl as ErrorResponseImpl,
  type HydrationState,
  Meta,
  type MetaFunction,
} from "react-router";
import {
  OperatorDashboard,
  OperatorDashboardStatus,
} from "../components/operator-dashboard.server";
import { getPublicEditorialPage, type PublicEditorialPath } from "../content/public-editorial";
import { getPublicAppConfig, type PublicAppConfig } from "../lib/app-config";
import type { CardSignalState } from "../lib/card-signal-ui";
import { PENDING_SCAN_STORAGE_KEY, type PendingScanRequest } from "../lib/pending-scan";
import { type ReportCardSignal, reportView } from "../lib/report-view";
import { resumeIntentKey, serializeResumeIntent } from "../lib/resume-intent";
import { type ScanFixtureName, scanFixture } from "../lib/scan-fixtures";
import type { getBrowserAnalyticsConfig } from "../lib/server/browser-analytics-config";
import { linkCooldownMessage } from "../lib/server/link-wait";
import type { OperatorDashboard as OperatorNumbers } from "../lib/server/operator-dashboard";
import { shareView } from "../lib/share-copy";
import routes from "./routes";

// --- the route tree, drawn ---------------------------------------------------

interface PageModule {
  readonly default?: ComponentType;
  readonly ErrorBoundary?: ComponentType;
  readonly meta?: MetaFunction;
  readonly loader?: () => unknown;
  readonly SiteBody?: ComponentType<{ children: ReactNode }>;
}

/**
 * The pages, the modules that draw something; a picture, a text or an API
 * route is no screen, and is matched with nothing to draw.
 */
const PAGES = import.meta.glob<PageModule>(
  ["./root.tsx", "./routes/*.tsx", "!./routes/*.test.tsx"],
  {
    eager: true,
  },
);

type StubRoute = Parameters<typeof createRoutesStub>[0][number];

const pageAt = (file: string): PageModule => {
  const page = PAGES[`./${file}`];
  if (page === undefined) throw new Error(`no page module at ${file}`);
  return page;
};

/** A route as the build makes it: its id is its file's path without the extension. */
const stubOf = (entry: RouteConfigEntry): StubRoute => {
  const page = PAGES[`./${entry.file}`];
  const route = {
    id: entry.id ?? entry.file.replace(/\.tsx?$/, ""),
    path: entry.path,
    Component: page?.default,
    ErrorBoundary: page?.ErrorBoundary,
    meta: page?.meta,
  };
  return entry.index === true
    ? { ...route, index: true }
    : { ...route, children: entry.children?.map(stubOf) };
};

const ROOT = pageAt("root.tsx");
const { SiteBody } = ROOT;
if (SiteBody === undefined) throw new Error("the root draws no body for its pages");

/**
 * In the body every page is drawn in, as the document's layout draws it, after
 * the title and the description the layout writes into the head.
 */
const inBody = (Page: ComponentType | undefined) =>
  Page === undefined
    ? undefined
    : function InBody() {
        return (
          <>
            <Meta />
            <SiteBody>
              <Page />
            </SiteBody>
          </>
        );
      };

const TREE: StubRoute[] = [
  {
    id: "root",
    path: "/",
    Component: inBody(ROOT.default),
    ErrorBoundary: inBody(ROOT.ErrorBoundary),
    meta: ROOT.meta,
    children: routes.map(stubOf),
  },
];

/** The page's own data, where its loader reads nothing but the page's content. */
const ownDataOf = (file: string): unknown => {
  const loader = pageAt(file).loader;
  if (loader === undefined) throw new Error(`${file} loads nothing of its own`);
  return loader();
};

// --- the site --------------------------------------------------------------------

/**
 * The public settings of a deployment at the live site's address that names
 * nothing else, as `getPublicAppConfig` reads them from such an environment.
 */
const SITE: PublicAppConfig = (() => {
  const named = [
    "APP_BASE_URL",
    "PRIVACY_EMAIL",
    "ABUSE_EMAIL",
    "LEGAL_OPERATOR",
    "LEGAL_IDENTITY_CONFIRMED",
  ] as const;
  const kept = named.map((name) => [name, process.env[name]] as const);
  try {
    for (const name of named) delete process.env[name];
    process.env.APP_BASE_URL = "https://agentify.ad";
    return getPublicAppConfig();
  } finally {
    for (const [name, value] of kept) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
})();

/** No analytics destination configured: nothing loads until a visitor allows it. */
const ANALYTICS: ReturnType<typeof getBrowserAnalyticsConfig> = {
  runtimeEnvironment: "production",
  posthog: { key: null, host: null, destinationEnvironment: "production" },
  meta: { pixelId: null, destinationEnvironment: "production" },
};

interface Drawn {
  readonly path: string;
  readonly loaded?: HydrationState["loaderData"];
  readonly failed?: HydrationState["errors"];
  readonly scene?: BrowserScene;
  /**
   * A visitor whose browser keeps no answer to the consent banner, so the
   * banner is up over the page. Every other state is drawn as a visitor who
   * answered it sees the page, since the banner would cover its foot.
   */
  readonly firstVisit?: true;
}

type Told = Omit<GalleryState, "address" | "draw" | "scene">;

/** A state at its address, drawn by the route tree as the server answers that address. */
const at = (told: Told, { path, loaded, failed, scene, firstVisit }: Drawn): GalleryState => ({
  ...told,
  address: path,
  ...(scene === undefined ? {} : { scene }),
  draw: () => {
    const Stub = createRoutesStub(TREE);
    return (
      <>
        <Stub
          initialEntries={[path]}
          hydrationData={{
            loaderData: { root: { app: SITE, analytics: ANALYTICS }, ...loaded },
            ...(failed === undefined ? {} : { errors: failed }),
          }}
        />
        {firstVisit ? null : <BannerAnswered />}
      </>
    );
  },
});

/** A page whose loader returns its own content, at its address. */
const own = (told: Told, path: string, file: string): GalleryState =>
  at(told, { path, loaded: { [file.replace(/\.tsx$/, "")]: ownDataOf(file) } });

const editorial = (told: Told, path: PublicEditorialPath, id: string): GalleryState =>
  at(told, { path, loaded: { [id]: getPublicEditorialPage(path, SITE) } });

// --- example data ----------------------------------------------------------------

/** An identifier of the shape the scanner gives, the same every time it is drawn. */
const uuidOf = (seed: string): string => {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const SCAN = uuidOf("a scan of shop.example");
const SHOP = "shop.example";
const WHO = "owner@shop.example";
const TOKEN_KEY = `agentify:scan-token:${SCAN}`;
/** A token's place, held by words no token carries. */
const TOKEN = "the-scan-link-token-from-the-address-bar";

const SIGNED_OUT = { status: 200, body: { status: "signed_out" } };
const SIGNED_IN = { status: 200, body: { status: "signed_in", email: WHO, operator: false } };

/** The site's answer to who is visiting, which every page's header asks for. */
const visitor = (signedIn: boolean) => ({
  "GET /api/v2/session": signedIn ? SIGNED_IN : SIGNED_OUT,
});

/** When the shop's scan last changed: for a finished one, the moment it finished. */
const SCANNED_AT = "2026-10-13T07:59:10.000Z";

/** The status the scan page's own example of this name carries, read about the shop. */
const fixtureStatus = (name: ScanFixtureName): ScanStatusResponse => {
  const fixture = scanFixture(name);
  if (fixture === null) throw new Error(`the scan page has no example named ${name}`);
  return { ...fixture.status, target_host: SHOP, updated_at: SCANNED_AT };
};

/** A finished scan's teaser at another score, its level the scanner's own for that score. */
const teaserAt = (score: number, coverage = 1): ScanStatusResponse => {
  const status = fixtureStatus("teaser");
  if (status.teaser === undefined) throw new Error("the scan page's teaser example has no teaser");
  return {
    ...status,
    status: coverage < 1 ? "partial" : "completed",
    teaser: { ...status.teaser, score, coverage, level: levelForScore(score, coverage) },
  };
};

const OBSERVATION: BrowserObservationStatusResponse = {
  version: "browser-public-v2.0.0",
  status: "partial",
  non_scoring: true,
  pages_assessed: 2,
  findings: [
    {
      id: "accessibility_structure",
      status: "partial",
      summary_code: "unnamed_controls_found",
      user_impact_code: "agents_cannot_identify_controls",
      remediation_code: "name_interactive_controls",
      evidence: { unnamed_control_count: 3 },
    },
    {
      id: "browser_console_health",
      status: "unavailable",
      summary_code: "provider_timeout",
      evidence: {},
    },
  ],
  updated_at: "2026-10-13T08:00:00.000Z",
};

interface ScanSeen {
  readonly status?: SiteAnswerOf<ScanStatusResponse>;
  readonly observation?: BrowserObservationStatusResponse;
  readonly signedIn?: boolean;
  readonly token?: boolean;
  readonly more?: BrowserScene["answers"];
  readonly steps?: BrowserScene["steps"];
  readonly shows: string;
}

type SiteAnswerOf<Body> = Readonly<{ status: number; body?: Body }>;

/** The public preview a finished scan's share offers, never published yet. */
const sharePreview = (score: number | null, level: string) =>
  score === null
    ? {}
    : {
        [`GET /api/v1/scans/${SCAN}/share-preview`]: {
          status: 200,
          body: {
            host: SHOP,
            score,
            level,
            rubric_version: "gtm-v1.0.0",
            generated_at: SCANNED_AT,
            existing_share: null,
          },
        },
      };

const sharePreviewOf = (status: ScanStatusResponse | undefined) =>
  status?.teaser === undefined ? {} : sharePreview(status.teaser.score, status.teaser.level);

/**
 * A private scan's page as the browser holding its link draws it: the token
 * the link carried in the tab, and the scan's status as the API answers it.
 */
const scan = (told: Told, seen: ScanSeen): GalleryState =>
  at(told, {
    path: `/scan/${SCAN}?segment=store`,
    loaded: {
      "routes/scan.id": {
        scanId: SCAN,
        browserObservationsEnabled: true,
        publicShareEnabled: true,
        remediationPromptEnabled: true,
        registrationEnabled: true,
        segment: "store",
        fixture: null,
      },
    },
    scene: {
      session: seen.token === false ? {} : { [TOKEN_KEY]: TOKEN },
      answers: {
        ...visitor(seen.signedIn === true),
        ...(seen.status === undefined ? {} : { [`GET /api/v1/scans/${SCAN}/status`]: seen.status }),
        [`GET /api/v1/scans/${SCAN}/browser-observation`]:
          seen.observation === undefined
            ? { status: 204 }
            : { status: 200, body: seen.observation },
        ...sharePreviewOf(seen.status?.body),
        ...seen.more,
      },
      ...(seen.steps === undefined ? {} : { steps: seen.steps }),
      shows: seen.shows,
    },
  });

const ended = (name: ScanFixtureName) => ({ status: 200, body: fixtureStatus(name) });

/**
 * A form field by its name, as a person types into it. The markup is written
 * too, since the page is read as markup and a typed value lives only in the
 * field's state.
 */
const typeInto = (page: Document, name: string, value: string) => {
  const field = page.querySelector<HTMLInputElement>(`[name="${name}"]`);
  if (field === null) throw new Error(`no field named ${name}`);
  field.value = value;
  field.setAttribute("value", value);
};

const tick = (page: Document, name: string) => {
  const box = page.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (box === null) throw new Error(`no box named ${name}`);
  box.checked = true;
  box.setAttribute("checked", "");
};

const press = (page: Document, words: string) => {
  const button = [...page.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === words,
  );
  if (button === undefined) throw new Error(`no button says ${words}`);
  button.click();
};

/** Presses the button that opens the menu at the end of the header's row. */
const openTheMenu = (page: Document) => {
  const button = page.querySelector<HTMLElement>(".site-menu > summary");
  if (button === null) throw new Error("the page draws no menu");
  button.click();
};

const askForTheReport = (page: Document) => {
  typeInto(page, "email", WHO);
  tick(page, "site_is_mine");
  tick(page, "dataset_reuse_acknowledged");
  const form = page.querySelector("form");
  if (form === null) throw new Error("no form to send");
  form.requestSubmit();
};

/** Public by design: the challenge's widget is drawn with it in every visitor's browser. */
const TURNSTILE_SITE_KEY = "the-challenge-widget-site-key";

const PENDING: PendingScanRequest = {
  url: "shop.example",
  segment: "store",
  variant: "store-v1",
  idempotencyKey: uuidOf("the press that asked for the scan"),
  landingPath: "/store",
  landingSearch: "",
};

/**
 * Cloudflare's script draws the challenge's widget into its box, and the
 * gallery's frames run no script: the gallery draws a labelled box of the
 * widget's size there instead, which the site never shows.
 */
const withChallengeStandIn = (state: GalleryState): GalleryState => ({
  ...state,
  draw: () => (
    <>
      {state.draw()}
      <style>
        {
          '[data-sitekey]::before{content:"Cloudflare Turnstile widget: drawn here by Cloudflare on the site, a stand-in in the gallery";display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:300px;max-width:100%;min-height:65px;padding:8px 12px;border:1px dashed var(--line-strong);border-radius:4px;color:var(--muted);font:0.75rem/1.4 var(--font-mono);text-align:center}'
        }
      </style>
    </>
  ),
});

/** The scan request the landing's form left in the tab, answered as the API answers it. */
const pending = (told: Told, answer: SiteAnswerOf<unknown> | null, shows: string) =>
  at(told, {
    path: "/scan/pending",
    loaded: { "routes/scan.pending": { turnstileSiteKey: TURNSTILE_SITE_KEY } },
    scene: {
      session: answer === null ? {} : { [PENDING_SCAN_STORAGE_KEY]: JSON.stringify(PENDING) },
      answers: {
        ...visitor(false),
        "POST /api/v1/attribution": { status: 201 },
        ...(answer === null ? {} : { "POST /api/v1/scans": answer }),
      },
      shows,
    },
  });

const refusal = (code: string, message: string, retryable: boolean, wait?: number) => ({
  error: {
    code,
    message,
    retryable,
    request_id: "req_gallery",
    ...(wait === undefined ? {} : { retry_after_seconds: wait }),
  },
});

/** A store's report: its structured data missing, robots.txt keeping out the MCP card. */
const reportOf = (score: number): ReportResponse => ({
  scan_id: SCAN,
  host: SHOP,
  segment: "store",
  score,
  coverage: 0.94,
  level: levelForScore(score, 0.94),
  benchmark: { sample_size: 42, average_score: 51.4 },
  checks: CHECK_DEFINITIONS.map((check) => ({
    id: check.id,
    label_code: check.labelCode,
    status:
      score < 40 && [3, 5, 6, 8, 12].includes(check.id)
        ? "fail"
        : check.id === 6
          ? "fail"
          : check.id === 7
            ? "partial"
            : check.id === 9
              ? "unavailable"
              : "pass",
    summary_code: check.id === 6 ? "vertical_jsonld_missing" : null,
    user_impact_code: null,
    fix_code: check.id === 6 ? "publish_vertical_jsonld" : null,
    robots: check.id === 9 ? "disallowed" : null,
    evidence: (check.id === 6 ? { detected_types: ["Organization", "WebSite"] } : {}) as Record<
      string,
      string[]
    >,
  })),
});

const report = (
  told: Told,
  drawn: ReportResponse,
  {
    observation,
    card,
    scene,
  }: {
    observation?: BrowserObservationStatusResponse;
    card?: CardSignalState;
    scene?: BrowserScene;
  } = {},
) =>
  at(told, {
    path: `/report/${SCAN}`,
    loaded: {
      "routes/report.scanId": {
        kind: "report",
        view: reportView(drawn, observation, {
          brand: SITE.displayBrand,
          promptEnabled: true,
          shareEnabled: true,
          cardSignal: {
            adapter: "local",
            publishableKey: null,
            ...(card === undefined
              ? {}
              : {
                  initialSignal: {
                    signalId: uuidOf("the card signal"),
                    status: card,
                    clientSecret: null,
                  },
                }),
          } satisfies ReportCardSignal,
        }),
      },
    },
    ...(scene === undefined ? {} : { scene }),
  });

const NOT_FOUND = new ErrorResponseImpl(404, "Not Found", null);

const NUMBERS: OperatorNumbers = {
  generatedAt: "2026-10-13T08:00:00.000Z",
  turnstileEnforced: true,
  overview: {
    visitorsTotal: 48_210,
    visitors30d: 1_234,
    landingViews30d: 2_051,
    scansTotal: 9_870,
    scans30d: 640,
    completedScans30d: 598,
    uniqueSites30d: 512,
    verifiedRegistrations30d: 32,
    shares30d: 11,
    acceptedRequests24h: 27,
    challengePasses1h: 4,
    browserUsageUsdToday: 1.2345,
  },
  daily: ["2026-10-13", "2026-10-12", "2026-10-11", "2026-10-10", "2026-10-09"].map(
    (day, back) => ({
      day,
      visitors: 40 + back * 3,
      landingViews: 70 + back * 5,
      scans: 21 - back,
      completedScans: 20 - back,
      verifiedRegistrations: back % 2,
      shares: back === 1 ? 1 : 0,
    }),
  ),
  recentScans: [
    {
      targetHost: "shop.example",
      segment: "store",
      status: "completed",
      score: 72,
      coverage: 0.94,
    },
    { targetHost: "example.com", segment: "owner", status: "partial", score: 46, coverage: 0.78 },
    {
      targetHost: "elsewhere.example",
      segment: "local",
      status: "failed",
      score: null,
      coverage: null,
    },
  ].map((scanned, back) => ({
    ...scanned,
    scanId: uuidOf(`a recent scan ${back}`),
    level:
      scanned.score === null || scanned.coverage === null
        ? null
        : levelForScore(scanned.score, scanned.coverage),
    acceptedAt: `2026-10-13T07:${String(58 - back * 9).padStart(2, "0")}:00.000Z`,
    finishedAt: `2026-10-13T07:${String(59 - back * 9).padStart(2, "0")}:10.000Z`,
    durationSeconds: 70 - back * 12,
    browserStatus: scanned.status === "failed" ? null : "completed",
  })),
  selfScan: null,
};

const account = (told: Told, path: string, file: string, scene: BrowserScene | null) =>
  at(told, { path, ...(scene === null ? {} : { scene }), loaded: { [file]: null } });

const DATA_REQUEST = "POST /api/v1/account/data-request";
const UNSUBSCRIBE = "POST /api/v1/account/unsubscribe";

// --- the states ------------------------------------------------------------------

const PUBLIC: GalleryState[] = [
  own(
    {
      id: "scanner-front-page",
      screen: "Front page",
      when: "Somebody opens agentify.ad.",
      cause: "The front page is the landing for a business owner, with the scan form at its top.",
    },
    "/",
    "routes/home.tsx",
  ),
  at(
    {
      id: "scanner-front-page-first-visit",
      screen: "Front page",
      when: "Somebody opens agentify.ad for the first time, or after clearing what their browser keeps.",
      cause:
        "The browser keeps no answer about measuring the visit, so the banner over the page asks for one.",
    },
    { path: "/", loaded: { "routes/home": ownDataOf("routes/home.tsx") }, firstVisit: true },
  ),
  own(
    {
      id: "scanner-store-landing",
      screen: "Store landing",
      when: "Somebody follows a link made for online stores.",
      cause: "The landing for stores, whose scan reads catalog signals.",
    },
    "/store",
    "routes/store.tsx",
  ),
  own(
    {
      id: "scanner-local-landing",
      screen: "Local business landing",
      when: "Somebody follows a link made for local businesses.",
      cause: "The landing for local businesses, whose scan reads local business signals.",
    },
    "/local",
    "routes/local.tsx",
  ),
  editorial(
    {
      id: "scanner-privacy",
      screen: "Privacy",
      when: "Somebody opens the privacy notice from any page's footer.",
      cause: "The operator's identity is shown as a deployment that names none shows it.",
    },
    "/privacy",
    "routes/privacy",
  ),
  at(
    {
      id: "scanner-privacy-menu",
      screen: "Privacy",
      when: "A signed-in visitor on a phone opens the menu at the end of the header's row.",
      cause:
        "The bar has no room for the site's sections beside who is visiting, so the menu holds them.",
    },
    {
      path: "/privacy",
      loaded: { "routes/privacy": getPublicEditorialPage("/privacy", SITE) },
      scene: {
        answers: visitor(true),
        steps: [{ shows: "Privacy and data controls", does: openTheMenu }],
        shows: WHO,
      },
    },
  ),
  editorial(
    {
      id: "scanner-terms",
      screen: "Terms",
      when: "Somebody opens the terms from any page's footer.",
      cause: "The operator's identity is shown as a deployment that names none shows it.",
    },
    "/terms",
    "routes/terms",
  ),
  own(
    {
      id: "scanner-agentic-shop",
      screen: "Sell to agents",
      when: "A business that wants agents to buy from it follows Sell to agents.",
      cause: "The landing for merchants, leading to the seller dashboard.",
    },
    "/agentic-shop",
    "routes/agentic-shop.tsx",
  ),
  own(
    {
      id: "scanner-agentic-shop-privacy",
      screen: "Merchant application privacy",
      when: "Somebody who sent the retired merchant application looks up what happens to it.",
      cause:
        "The notice the closed application form was sent under, kept while its submissions expire.",
    },
    "/agentic-shop/privacy",
    "routes/agentic-shop.privacy.tsx",
  ),
  own(
    {
      id: "scanner-sell",
      screen: "Merchant landing with prices",
      when: "Somebody opens /sell on the test site; the live site answers it with the missing page.",
      cause: "The draft landing with prices, not yet offered on the live channel.",
    },
    "/sell",
    "routes/sell.tsx",
  ),
  at(
    {
      id: "scanner-no-such-page",
      screen: "Page not found",
      when: "Somebody opens an address the scanner has no page for.",
      cause: "No route takes the address, so the page that says so is answered with status 404.",
    },
    { path: "/pricing", loaded: { "routes/not-found": null } },
  ),
];

const SCANNING: GalleryState[] = [
  at(
    {
      id: "scanner-pending-starting",
      screen: "Starting a scan",
      when: "Somebody presses Scan my site, while the request is on its way.",
      cause: "The page has handed the request over and waits for the scanner to accept it.",
    },
    {
      path: "/scan/pending",
      loaded: { "routes/scan.pending": { turnstileSiteKey: TURNSTILE_SITE_KEY } },
    },
  ),
  withChallengeStandIn(
    pending(
      {
        id: "scanner-pending-challenge",
        screen: "Starting a scan",
        when: "Somebody asks for a fourth scan within an hour from one network.",
        cause:
          "The scanner asks for a challenge before it takes more scans from that network; Cloudflare's widget draws in the box.",
      },
      {
        status: 429,
        body: refusal("challenge_required", "Complete the challenge to continue.", true, 60),
      },
      "Complete the challenge to continue.",
    ),
  ),
  pending(
    {
      id: "scanner-pending-hard-limit",
      screen: "Starting a scan",
      when: "A network or a site has had all the scans it gets for now.",
      cause: "The scanner's hard limit refused the scan; retrying from the page cannot help.",
    },
    {
      status: 429,
      body: refusal("hard_rate_limit", "The scan limit has been reached.", true, 1_800),
    },
    "This network or target reached the hard scan limit.",
  ),
  pending(
    {
      id: "scanner-pending-busy",
      screen: "Starting a scan",
      when: "Somebody asks for a scan while the scanner cannot take one.",
      cause: "The scanner's queue or records did not answer, so no scan was started.",
    },
    {
      status: 503,
      body: refusal("temporarily_busy", "The scanner queue is temporarily unavailable.", true, 30),
    },
    "The scanner could not take this scan just now.",
  ),
  pending(
    {
      id: "scanner-pending-address-refused",
      screen: "Starting a scan",
      when: "Somebody asks for a scan of an address that is not a public website.",
      cause: "The scanner refuses the address itself, so only another address can help.",
    },
    {
      status: 400,
      body: refusal(
        "invalid_url",
        "This address cannot be scanned. Enter the public address of a website, such as https://example.com, with no port, sign-in details or private keys in it.",
        false,
      ),
    },
    "This address cannot be scanned.",
  ),
  pending(
    {
      id: "scanner-pending-missing",
      screen: "Starting a scan",
      when: "Somebody opens the page again after the request was sent, or in another tab.",
      cause: "The tab holds no scan request to send.",
    },
    null,
    "This scan request is missing or expired.",
  ),
  scan(
    {
      id: "scanner-scan-queued",
      screen: "Scan",
      when: "A scan was accepted while the scanner is busy with others.",
      cause: "The scan waits for capacity; no check has started.",
    },
    {
      status: {
        status: 200,
        body: {
          ...fixtureStatus("running"),
          status: "queued",
          progress: { completed: 0, total: 18 },
          checks: [],
        },
      },
      shows: "Waiting for scanner capacity",
    },
  ),
  scan(
    {
      id: "scanner-scan-running",
      screen: "Scan",
      when: "A scan is under way and its checks are reporting.",
      cause: "Seven of eighteen checks have a result, one is running, the rest wait.",
    },
    { status: ended("running"), shows: "7 of 18 checks reported" },
  ),
  scan(
    {
      id: "scanner-scan-menu",
      screen: "Scan",
      when: "A signed-in visitor follows a running scan on a phone and opens the menu.",
      cause:
        "The scan's top has room for the lockup and the doors alone, so the menu holds the site's sections and who is visiting.",
    },
    {
      status: ended("running"),
      signedIn: true,
      steps: [{ shows: "7 of 18 checks reported", does: openTheMenu }],
      shows: WHO,
    },
  ),
  scan(
    {
      id: "scanner-scan-failed",
      screen: "Scan",
      when: "A scan ends without a result to show.",
      cause: "Too few checks could be assessed for a reliable result.",
    },
    { status: ended("failed"), shows: "Scan ended without a reliable result" },
  ),
  scan(
    {
      id: "scanner-scan-blocked",
      screen: "Scan",
      when: "A scanned site turns the scanner away.",
      cause:
        "The site answered the scanner's request for its home page with a bot challenge or a refusal.",
    },
    { status: ended("blocked"), shows: "Scan ended without a reliable result" },
  ),
  scan(
    {
      id: "scanner-scan-kept-out",
      screen: "Scan",
      when: "A scanned site's robots.txt keeps the scanner out of what it reads.",
      cause:
        "robots.txt disallows the scanner from most of what the checks read, so no verdict is given.",
    },
    { status: ended("robots"), shows: "Scan ended without a reliable result" },
  ),
  scan(
    {
      id: "scanner-scan-invisible",
      screen: "Scan",
      when: "A scan finds a site agents can barely read.",
      cause: "The score is in the invisible band, up to 24.",
    },
    { status: { status: 200, body: teaserAt(18) }, shows: "Invisible" },
  ),
  scan(
    {
      id: "scanner-scan-readable",
      screen: "Scan",
      when: "A scan finds useful foundations with material gaps.",
      cause: "The score is in the readable band, 25 to 49.",
    },
    { status: ended("teaser"), shows: "Readable" },
  ),
  scan(
    {
      id: "scanner-scan-callable-ready",
      screen: "Scan",
      when: "A scan finds strong discovery metadata.",
      cause: "The score is in the callable-ready band, 50 to 69.",
    },
    { status: { status: 200, body: teaserAt(63) }, shows: "Callable-ready" },
  ),
  scan(
    {
      id: "scanner-scan-ahead",
      screen: "Scan",
      when: "A scan finds a strong public agent-readiness baseline.",
      cause: "The score is 70 or more.",
    },
    { status: { status: 200, body: teaserAt(84) }, shows: "Ahead of the market" },
  ),
  scan(
    {
      id: "scanner-scan-incomplete",
      screen: "Scan",
      when: "A scan could read too little of a site for a confident level.",
      cause: "Coverage is under seventy percent, so the result is provisional.",
    },
    { status: { status: 200, body: teaserAt(41, 0.62) }, shows: "Incomplete" },
  ),
  scan(
    {
      id: "scanner-scan-partial",
      screen: "Scan",
      when: "A scan finishes with some checks unavailable.",
      cause: "Four checks could not be assessed; they lower the coverage and count as no failure.",
    },
    { status: ended("partial"), shows: "Some checks were unavailable." },
  ),
  scan(
    {
      id: "scanner-scan-partly-kept-out",
      screen: "Scan",
      when: "A scan finishes while robots.txt keeps the scanner out of a few files.",
      cause:
        "robots.txt disallows the well-known files three checks read, so those are not assessed.",
    },
    { status: ended("robots-partial"), shows: "Scan complete with unavailable checks" },
  ),
  scan(
    {
      id: "scanner-scan-with-browser",
      screen: "Scan",
      when: "A finished scan's browser observation has come in.",
      cause: "A real browser looked at the site beside the scan, outside the score.",
    },
    { status: ended("teaser"), observation: OBSERVATION, shows: "Browser check" },
  ),
  scan(
    {
      id: "scanner-scan-browser-running",
      screen: "Scan",
      when: "A scan has finished while a real browser is still looking at the site.",
      cause:
        "The browser observation runs after the eighteen checks, so its part of the result says it is on its way.",
    },
    {
      status: ended("teaser"),
      observation: { ...OBSERVATION, status: "running", pages_assessed: 0, findings: [] },
      shows: "This step runs after the report.",
    },
  ),
  scan(
    {
      id: "scanner-scan-browser-unreadable",
      screen: "Scan",
      when: "A scan has finished while its browser observation cannot be read.",
      cause:
        "The site answered the page's ask for the observation with an error; the eighteen checks stand without it.",
    },
    {
      status: ended("teaser"),
      more: { [`GET /api/v1/scans/${SCAN}/browser-observation`]: { status: 503 } },
      shows: "Browser observations are temporarily unavailable",
    },
  ),
  scan(
    {
      id: "scanner-scan-signed-in",
      screen: "Scan",
      when: "A person already signed in finishes a scan.",
      cause: "The full report will be filed under the signed-in address, with no message sent.",
    },
    { status: ended("teaser"), signedIn: true, shows: "You are signed in" },
  ),
  scan(
    {
      id: "scanner-scan-registration-sent",
      screen: "Scan",
      when: "A visitor asks for the full report with their email.",
      cause:
        "The scanner sent a secure link to the address; opening it in this browser opens the report.",
    },
    {
      status: ended("teaser"),
      more: {
        [`POST /api/v2/scans/${SCAN}/registrations`]: {
          status: 202,
          body: { status: "verification_sent" },
        },
      },
      steps: [{ shows: "Email me a secure link", does: askForTheReport }],
      shows: "Check your inbox",
    },
  ),
  scan(
    {
      id: "scanner-scan-registration-refused",
      screen: "Scan",
      when: "A visitor asks for the full report again after the address had all its links for the hour.",
      cause: "The scanner refused to send another link and says how long the wait is.",
    },
    {
      status: ended("teaser"),
      more: {
        [`POST /api/v2/scans/${SCAN}/registrations`]: {
          status: 429,
          body: refusal(
            "verification_link_cooldown",
            linkCooldownMessage("address_hour", 2_400),
            true,
            2_400,
          ),
        },
      },
      steps: [{ shows: "Email me a secure link", does: askForTheReport }],
      shows: "No new link was sent",
    },
  ),
  scan(
    {
      id: "scanner-scan-prompt-needs-email",
      screen: "Scan",
      when: "A visitor presses Copy AI fix prompt before confirming their email.",
      cause:
        "The prompt is given only to a confirmed address, so the page points at the form for the full report.",
    },
    {
      status: ended("teaser"),
      more: { [`GET /api/v2/scans/${SCAN}/contact-access`]: { status: 401 } },
      steps: [{ shows: "Copy AI fix prompt", does: (page) => press(page, "Copy AI fix prompt") }],
      shows: "Confirm your email in the highlighted form",
    },
  ),
  scan(
    {
      id: "scanner-scan-no-access",
      screen: "Scan",
      when: "Somebody opens a scan's address without the private link that started it.",
      cause: "The tab holds no token for the scan, so its progress is not shown.",
    },
    { token: false, shows: "Open the original private scan link" },
  ),
  scan(
    {
      id: "scanner-scan-link-invalid",
      screen: "Scan",
      when: "Somebody opens a scan's private link after it stopped working.",
      cause: "The API refuses the token the link carried.",
    },
    { status: { status: 401 }, shows: "This scan link is no longer valid" },
  ),
  scan(
    {
      id: "scanner-scan-status-unreadable",
      screen: "Scan",
      when: "A scan's progress cannot be read for a moment.",
      cause:
        "The API answered the page's poll with no status it could read; the page keeps asking.",
    },
    { status: { status: 503 }, shows: "Live status is temporarily unreachable" },
  ),
];

const REPORTS: GalleryState[] = [
  report(
    {
      id: "scanner-report-low",
      screen: "Full report",
      when: "The owner of a site agents can barely read opens its full report.",
      cause: "The report is filed under the signed-in address; the score is in the invisible band.",
    },
    reportOf(19),
  ),
  report(
    {
      id: "scanner-report-high",
      screen: "Full report",
      when: "The owner of a well-prepared site opens its full report.",
      cause: "The report is filed under the signed-in address; the score is 70 or more.",
    },
    reportOf(81),
  ),
  report(
    {
      id: "scanner-report-with-browser",
      screen: "Full report",
      when: "A report whose site a real browser also observed is opened.",
      cause: "The browser observation finished, so its findings stand beside the checks.",
    },
    reportOf(46),
    { observation: OBSERVATION },
  ),
  report(
    {
      id: "scanner-report-card-saving",
      screen: "Full report",
      when: "A report owner who agreed to save a card comes back while the provider confirms it.",
      cause: "The card signal waits for the payment provider's confirmation.",
    },
    reportOf(46),
    { card: "setup_pending" },
  ),
  report(
    {
      id: "scanner-report-card-saved",
      screen: "Full report",
      when: "A report owner saved a card for a future purchase.",
      cause: "The payment provider confirmed the card; nothing was charged.",
    },
    reportOf(46),
    { card: "attached" },
  ),
  report(
    {
      id: "scanner-report-card-removed",
      screen: "Full report",
      when: "A report owner removed the card they saved.",
      cause: "The provider confirmed the card was detached.",
    },
    reportOf(46),
    { card: "detached" },
  ),
  report(
    {
      id: "scanner-report-card-failed",
      screen: "Full report",
      when: "Saving a card did not go through.",
      cause: "The payment provider did not confirm the card.",
    },
    reportOf(46),
    { card: "failed" },
  ),
  report(
    {
      id: "scanner-report-confirmed",
      screen: "Full report",
      when: "A visitor opens the emailed link after asking for the fix prompt on the scan page.",
      cause: "The address is confirmed, and the prompt they asked for is ready on the report.",
    },
    reportOf(46),
    {
      scene: {
        local: { [resumeIntentKey(SCAN)]: serializeResumeIntent("copy-prompt", Date.now()) },
        answers: { ...visitor(true), ...sharePreview(46, levelForScore(46, 0.94)) },
        shows: "Verified",
      },
    },
  ),
  at(
    {
      id: "scanner-report-stranger",
      screen: "Full report",
      when: "Somebody not signed in opens a report's address.",
      cause: "A report opens only for the address it is filed under.",
    },
    { path: `/report/${SCAN}`, loaded: { "routes/report.scanId": { kind: "stranger" } } },
  ),
  at(
    {
      id: "scanner-report-not-yours",
      screen: "Full report",
      when: "A person signed in with another address opens a report.",
      cause: "The report is filed under a different address than the one signed in.",
    },
    {
      path: `/report/${SCAN}`,
      loaded: { "routes/report.scanId": { kind: "not_yours", email: "sales@example.com" } },
    },
  ),
  at(
    {
      id: "scanner-report-unknown-visitor",
      screen: "Full report",
      when: "A report is opened while the seller dashboard does not answer who is signed in.",
      cause: "Not knowing who is visiting is said as such, never as a stranger.",
    },
    {
      path: `/report/${SCAN}`,
      loaded: { "routes/report.scanId": { kind: "unknown", scanId: SCAN } },
    },
  ),
  at(
    {
      id: "scanner-latest-report-unknown",
      screen: "Latest report",
      when: "The seller dashboard sends a signed-in person to their latest report while it cannot say who they are.",
      cause:
        "Every other visitor is sent on before a page is drawn: to their latest report, to the dashboard, or to its sign-in.",
    },
    { path: "/report/latest", loaded: { "routes/report.latest": null } },
  ),
  at(
    {
      id: "scanner-share",
      screen: "Published result",
      when: "Somebody opens a result its owner published.",
      cause:
        "The share's public snapshot: the domain, the level, the score and the scan date, nothing else.",
    },
    {
      path: "/s/k7Qm2xR9",
      loaded: {
        "routes/s.slug": shareView(
          {
            host: SHOP,
            score: 46,
            level: "readable",
            rubric_version: "gtm-v1.0.0",
            generated_at: SCANNED_AT,
          },
          false,
        ),
      },
    },
  ),
  at(
    {
      id: "scanner-share-unpublished",
      screen: "Published result",
      when: "Somebody opens a result link that was never published or has been revoked.",
      cause:
        "No published share has the slug, so the page that says so is answered with status 404.",
    },
    { path: "/s/k7Qm2xR9", failed: { root: NOT_FOUND } },
  ),
];

const ACCOUNT: GalleryState[] = [
  account(
    {
      id: "scanner-data-request-asking",
      screen: "Data request",
      when: "Somebody opens the data request page, before it knows who is visiting.",
      cause:
        "The page asks who is signed in once its script runs; this is all a browser without script sees.",
    },
    "/data-request",
    "routes/data-request",
    null,
  ),
  account(
    {
      id: "scanner-data-request-signed-out",
      screen: "Data request",
      when: "Somebody not signed in opens the data request page.",
      cause: "Requests are made for the signed-in address, so the page asks to sign in first.",
    },
    "/data-request",
    "routes/data-request",
    { answers: visitor(false), shows: "Sign in" },
  ),
  account(
    {
      id: "scanner-data-request",
      screen: "Data request",
      when: "A signed-in person opens the data request page.",
      cause: "The page offers access and deletion for the signed-in address.",
    },
    "/data-request",
    "routes/data-request",
    { answers: visitor(true), shows: "Request data access" },
  ),
  account(
    {
      id: "scanner-data-request-recorded",
      screen: "Data request",
      when: "A signed-in person presses Request data access.",
      cause: "The request was recorded for the signed-in address.",
    },
    "/data-request",
    "routes/data-request",
    {
      answers: { ...visitor(true), [DATA_REQUEST]: { status: 200, body: { status: "requested" } } },
      steps: [{ shows: "Request data access", does: (page) => press(page, "Request data access") }],
      shows: "Request recorded.",
    },
  ),
  account(
    {
      id: "scanner-data-request-confirm-deletion",
      screen: "Data request",
      when: "A signed-in person presses Delete my data.",
      cause: "Deletion takes a second press, after the page says what it removes.",
    },
    "/data-request",
    "routes/data-request",
    {
      answers: visitor(true),
      steps: [{ shows: "Delete my data", does: (page) => press(page, "Delete my data") }],
      shows: "Confirm deletion",
    },
  ),
  account(
    {
      id: "scanner-data-request-deletion-requested",
      screen: "Data request",
      when: "A signed-in person confirms the deletion while part of it has to wait.",
      cause: "Report access closed at once and the rest of the deletion was queued.",
    },
    "/data-request",
    "routes/data-request",
    {
      answers: { ...visitor(true), [DATA_REQUEST]: { status: 200, body: { status: "requested" } } },
      steps: [
        { shows: "Delete my data", does: (page) => press(page, "Delete my data") },
        { shows: "Confirm deletion", does: (page) => press(page, "Confirm deletion") },
      ],
      shows: "Deletion was requested",
    },
  ),
  account(
    {
      id: "scanner-data-request-deleted",
      screen: "Data request",
      when: "A signed-in person confirms the deletion and it completes at once.",
      cause:
        "The card was cleared first, then the reports, shares and personal data were anonymized.",
    },
    "/data-request",
    "routes/data-request",
    {
      answers: { ...visitor(true), [DATA_REQUEST]: { status: 200, body: { status: "completed" } } },
      steps: [
        { shows: "Delete my data", does: (page) => press(page, "Delete my data") },
        { shows: "Confirm deletion", does: (page) => press(page, "Confirm deletion") },
      ],
      shows: "Deletion completed.",
    },
  ),
  account(
    {
      id: "scanner-data-request-not-matched",
      screen: "Data request",
      when: "A person presses a button on a page left open after signing in as another address.",
      cause:
        "The press named a different address than the one signed in now, so nothing was changed.",
    },
    "/data-request",
    "routes/data-request",
    {
      answers: {
        ...visitor(true),
        [DATA_REQUEST]: {
          status: 409,
          body: refusal(
            "page_not_matched",
            `The page this came from could not be matched to the address signed in now, ${WHO}, so nothing was changed. Reload the page to act as this address.`,
            false,
          ),
        },
      },
      steps: [{ shows: "Request data access", does: (page) => press(page, "Request data access") }],
      shows: "Reload this page",
    },
  ),
  account(
    {
      id: "scanner-data-request-unknown-visitor",
      screen: "Data request",
      when: "The page is opened while the seller dashboard does not answer who is signed in.",
      cause: "Not knowing who is visiting is said as such, and nothing is offered to press.",
    },
    "/data-request",
    "routes/data-request",
    {
      answers: { "GET /api/v2/session": { status: 503 } },
      shows: "We cannot tell who is visiting",
    },
  ),
  account(
    {
      id: "scanner-unsubscribe-signed-out",
      screen: "Email preferences",
      when: "Somebody not signed in follows Unsubscribe from an email.",
      cause: "Unsubscribing is for the signed-in address, so the page asks to sign in first.",
    },
    "/email/unsubscribe",
    "routes/email.unsubscribe",
    { answers: visitor(false), shows: "Sign in" },
  ),
  account(
    {
      id: "scanner-unsubscribe",
      screen: "Email preferences",
      when: "A signed-in person opens their email preferences.",
      cause: "The page offers to stop optional marketing email for the signed-in address.",
    },
    "/email/unsubscribe",
    "routes/email.unsubscribe",
    { answers: visitor(true), shows: "Unsubscribe from marketing" },
  ),
  account(
    {
      id: "scanner-unsubscribed",
      screen: "Email preferences",
      when: "A signed-in person presses Unsubscribe from marketing.",
      cause: "The address was taken off optional marketing email.",
    },
    "/email/unsubscribe",
    "routes/email.unsubscribe",
    {
      answers: { ...visitor(true), [UNSUBSCRIBE]: { status: 200, body: { status: "requested" } } },
      steps: [
        {
          shows: "Unsubscribe from marketing",
          does: (page) => press(page, "Unsubscribe from marketing"),
        },
      ],
      shows: "Request recorded.",
    },
  ),
  account(
    {
      id: "scanner-unsubscribe-not-answered",
      screen: "Email preferences",
      when: "A signed-in person presses Unsubscribe while the site is failing.",
      cause: "The site's answer could not be read, so the page says nothing was changed.",
    },
    "/email/unsubscribe",
    "routes/email.unsubscribe",
    {
      answers: { ...visitor(true), [UNSUBSCRIBE]: { status: 502 } },
      steps: [
        {
          shows: "Unsubscribe from marketing",
          does: (page) => press(page, "Unsubscribe from marketing"),
        },
      ],
      shows: "Nothing was changed",
    },
  ),
  at(
    {
      id: "scanner-admin",
      screen: "Operator dashboard",
      when: "An operator opens /admin; everybody else, a stranger included, gets the page not found.",
      cause:
        "The seller dashboard confirms the signed-in account as an operator; the numbers here are examples.",
    },
    {
      path: "/admin",
      loaded: {
        "routes/admin": {
          title: "Operator dashboard",
          status: renderToStaticMarkup(<OperatorDashboardStatus data={NUMBERS} />),
          html: renderToStaticMarkup(<OperatorDashboard data={NUMBERS} />),
        },
      },
    },
  ),
];

export const gallery: GallerySurface = {
  id: "scanner",
  name: "Scanner and public site",
  lang: "en-US",
  states: [...PUBLIC, ...SCANNING, ...REPORTS, ...ACCOUNT],
};
