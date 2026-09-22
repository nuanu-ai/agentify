import { getPublicShare } from "../../../lib/server/reporting";
import { renderShareImage } from "../../../lib/server/share-image";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const share = await getPublicShare(slug);
  if (share?.status !== "published") throw new Error("share_not_found");
  return renderShareImage(share.snapshot);
}
