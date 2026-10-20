import { type LoaderFunctionArgs, type MetaArgs, useLoaderData } from "react-router";

import { ReportLocked, type ReportLockedData } from "../../components/report-locked";
import { ReportPage } from "../../components/report-page";
import { getPublicAppConfig } from "../../lib/app-config";
import { pageMeta, siteConfigOf } from "../../lib/page-meta";
import { type ReportView, reportView } from "../../lib/report-view";
import { getServerConfig } from "../../lib/server/config";
import { loadReportPage } from "../../lib/server/reporting";
import { getOwnedCardSignalForReport } from "../../lib/server/stripe-card-signal";
import { getCardSignalPublicConfig } from "../../lib/server/stripe-card-signal-config";

/**
 * The full report, for the person it is filed under. Who is visiting is read
 * once and not renewed: the header's own call to the session route renews the
 * session. A session that arrived through the link asked for this report
 * completes that ask here, on its first visit.
 */
export const loader = async ({
  params,
  request,
}: LoaderFunctionArgs): Promise<
  ReportLockedData | Readonly<{ kind: "report"; view: ReportView }>
> => {
  const scanId = params.scanId ?? "";
  const page = await loadReportPage(scanId, request.headers.get("cookie"));
  if (page.kind === "unknown") return { kind: "unknown", scanId };
  if (page.kind === "stranger") return { kind: "stranger" };
  if (page.kind === "not_yours") return { kind: "not_yours", email: page.email };
  const config = getServerConfig();
  const card = getCardSignalPublicConfig();
  const owned = await getOwnedCardSignalForReport(scanId, page.visitor);
  return {
    kind: "report",
    view: reportView(page.report, page.browserObservation, {
      brand: getPublicAppConfig().displayBrand,
      promptEnabled: config.REMEDIATION_PROMPT_ENABLED,
      shareEnabled: config.PUBLIC_SHARE_ENABLED,
      cardSignal:
        card.enabled || owned !== undefined
          ? {
              adapter: owned?.adapter ?? card.adapter,
              publishableKey: card.publishableKey,
              signedInAs: page.visitor.email,
              ...(owned === undefined
                ? {}
                : {
                    initialSignal: {
                      signalId: owned.signalId,
                      status: owned.status,
                      clientSecret: owned.clientSecret,
                    },
                  }),
            }
          : null,
    }),
  };
};

export const meta = ({ matches }: MetaArgs) =>
  pageMeta(siteConfigOf(matches), {
    title: "Private diagnostic report",
    robots: "noindex, nofollow",
    referrer: "strict-origin",
  });

export default function ReportRoute() {
  const page = useLoaderData<typeof loader>();
  return page.kind === "report" ? <ReportPage view={page.view} /> : <ReportLocked page={page} />;
}
