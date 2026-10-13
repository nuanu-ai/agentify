/**
 * The operator's dashboard: read-only numbers about the scanner, for a session
 * whose account carries the operator flag.
 *
 * Nothing stands in front of /admin, so this page, and any page added beside
 * it, must refuse by itself. Anybody the seller dashboard does not confirm as
 * an operator gets the site's 404, whatever the method, including everybody
 * while the seller dashboard cannot answer. The refusal comes before any of
 * the page is drawn, and the page's words and head travel only in the
 * loader's answer, never in a script: a title shown to a visitor who is then
 * refused would tell them what this page is.
 */

import { renderToStaticMarkup } from "react-dom/server";
import {
  type ActionFunctionArgs,
  data,
  type LoaderFunctionArgs,
  type MetaArgs,
  useLoaderData,
} from "react-router";

import { Brand } from "../../components/brand";
import styles from "../../components/operator-dashboard.module.css";
import {
  OperatorDashboard,
  OperatorDashboardStatus,
} from "../../components/operator-dashboard.server";
import { pageMeta, siteConfigOf } from "../../lib/page-meta";
import { isOperator } from "../../lib/server/operator";
import { getOperatorDashboard } from "../../lib/server/operator-dashboard";

/** Throws the site's 404 for anybody the seller dashboard does not confirm as an operator. */
async function refuseAllButOperators(request: Request): Promise<void> {
  if (!(await isOperator(request.headers.get("cookie")))) throw data(null, { status: 404 });
}

export async function loader({ request }: LoaderFunctionArgs) {
  await refuseAllButOperators(request);
  const dashboard = await getOperatorDashboard();
  return {
    title: "Operator dashboard",
    status: renderToStaticMarkup(<OperatorDashboardStatus data={dashboard} />),
    html: renderToStaticMarkup(<OperatorDashboard data={dashboard} />),
  };
}

/** The page takes no posts, and says so only to an operator. */
export async function action({ request }: ActionFunctionArgs) {
  await refuseAllButOperators(request);
  throw data(null, { status: 405 });
}

export const meta = ({ matches, loaderData }: MetaArgs<typeof loader>) =>
  pageMeta(siteConfigOf(matches), { title: loaderData?.title, robots: "noindex, nofollow" });

export default function AdminPage() {
  const { status, html } = useLoaderData<typeof loader>();
  // React drew both on the server and escaped every value in them, the
  // scanned sites' hostnames included.
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Brand />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: drawn by React on the server */}
        <div dangerouslySetInnerHTML={{ __html: status }} />
      </header>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: drawn by React on the server */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </main>
  );
}
