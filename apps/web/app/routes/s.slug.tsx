import { data, type LoaderFunctionArgs, type MetaArgs, useLoaderData } from "react-router";

import { PublicSharePage } from "../../components/public-share-page";
import { siteConfigOf } from "../../lib/page-meta";
import { getPublicShare } from "../../lib/server/reporting";
import { shareCopy } from "../../lib/share-copy";

const SCAN_DATE = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

/**
 * A published result, or the page that says there is no such page for a link
 * never published or since revoked. Only the public snapshot leaves the
 * server: what the page draws is all a stranger holding the link may see.
 */
export const loader = async ({ params }: LoaderFunctionArgs) => {
  const share = await getPublicShare(params.slug ?? "");
  if (share === undefined) throw data(null, { status: 404 });
  const { snapshot } = share;
  const copy = shareCopy(snapshot);
  return {
    headline: copy.headline,
    subline: copy.subline,
    allowIndexing: share.allowIndexing,
    preview: {
      hostLabel: snapshot.host,
      level: snapshot.level,
      score: snapshot.score,
      scannedLabel: `Scanned ${SCAN_DATE.format(new Date(snapshot.generated_at))}`,
    },
  };
};

/**
 * The card a link to the result unfurls into is the result's own image, and a
 * crawler indexes and follows the page only where its owner allowed it.
 */
export const meta = ({ loaderData, params, matches }: MetaArgs<typeof loader>) => {
  const { displayBrand, baseUrl } = siteConfigOf(matches);
  if (loaderData === undefined) return [];
  const { headline, subline, allowIndexing, preview } = loaderData;
  const image = new URL(
    `/api/v1/shares/${encodeURIComponent(params.slug ?? "")}/image`,
    baseUrl,
  ).toString();
  return [
    { title: `${headline} · ${displayBrand}` },
    { name: "description", content: subline },
    { name: "robots", content: allowIndexing ? "index, follow" : "noindex, nofollow" },
    { property: "og:title", content: headline },
    { property: "og:description", content: subline },
    { property: "og:site_name", content: displayBrand },
    { property: "og:type", content: "website" },
    { property: "og:image", content: image },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    {
      property: "og:image:alt",
      content: `${headline} — ${preview.score}/100 public HTTP diagnostic`,
    },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: headline },
    { name: "twitter:description", content: subline },
    { name: "twitter:image", content: image },
  ];
};

export default function PublicShareRoute() {
  return <PublicSharePage preview={useLoaderData<typeof loader>().preview} />;
}
