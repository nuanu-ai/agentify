/**
 * The scanner's page of the operator's workspace: read-only numbers about the
 * scanner, for a session whose account carries the operator flag, in the
 * workspace's frame, whose other sections the seller dashboard draws.
 *
 * Nothing stands in front of /admin, so this page, and any page added beside
 * it, must refuse by itself. Anybody the seller dashboard does not confirm as
 * an operator gets the site's 404, whatever the method, including everybody
 * while the seller dashboard cannot answer. The refusal comes before any of
 * the page is drawn, and the page's words and head travel only in the
 * loader's answer, never in a script: a title shown to a visitor who is then
 * refused would tell them what this page is.
 */

import frameSheet from "@agentify/visual/frame.css?url";
import workspaceSheet from "@agentify/visual/workspace.css?url";
import {
  type ActionFunctionArgs,
  data,
  type LoaderFunctionArgs,
  type MetaArgs,
  useLoaderData,
} from "react-router";

import { drawOperatorPage } from "../../components/operator-dashboard.server";
import { pageMeta, siteConfigOf } from "../../lib/page-meta";
import { channelHere, operatorOf } from "../../lib/server/operator";
import { getOperatorDashboard } from "../../lib/server/operator-dashboard";

/** The operator's address, or the site's 404 for anybody the seller dashboard does not confirm as one. */
async function operatorOrNobody(request: Request): Promise<string> {
  const who = await operatorOf(request.headers.get("cookie"));
  if (who === null) throw data(null, { status: 404 });
  return who;
}

export const links = () => [
  { rel: "stylesheet", href: frameSheet },
  { rel: "stylesheet", href: workspaceSheet },
];

export async function loader({ request }: LoaderFunctionArgs) {
  const who = await operatorOrNobody(request);
  return {
    title: "Scanner — Agentify operator",
    html: drawOperatorPage({ data: await getOperatorDashboard(), who, channel: channelHere() }),
  };
}

/** The page takes no posts, and says so only to an operator. */
export async function action({ request }: ActionFunctionArgs) {
  await operatorOrNobody(request);
  throw data(null, { status: 405 });
}

export const meta = ({ matches, loaderData }: MetaArgs<typeof loader>) =>
  pageMeta(siteConfigOf(matches), {
    title: loaderData?.title,
    titleAlone: true,
    robots: "noindex, nofollow",
  });

export default function AdminPage() {
  const { html } = useLoaderData<typeof loader>();
  // React drew it on the server and escaped every value in it, the scanned
  // sites' hostnames included.
  // biome-ignore lint/security/noDangerouslySetInnerHtml: drawn by React on the server
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
