import { type NextRequest } from "next/server";

import { errorResponse } from "../../../../../../lib/server/http";
import { getPublicShare } from "../../../../../../lib/server/reporting";
import { renderShareImage } from "../../../../../../lib/server/share-image";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const share = await getPublicShare(slug);
  if (!share || share.status !== "published")
    return errorResponse(
      request,
      404,
      "share_not_found",
      "The public link was not found.",
    );
  const response = renderShareImage(share.snapshot);
  response.headers.set(
    "Content-Disposition",
    `attachment; filename="agentify-${share.snapshot.host.replace(/[^a-z0-9.-]/gi, "-")}.png"`,
  );
  return response;
}
