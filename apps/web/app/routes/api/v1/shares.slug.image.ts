import { pictureAnswer } from "../../../../lib/server/drawing";
import { errorResponse } from "../../../../lib/server/http";
import { methods } from "../../../../lib/server/methods";
import { getPublicShare } from "../../../../lib/server/reporting";
import { drawShareImage } from "../../../../lib/server/share-image";

/** A published share's card as a file to save, named after the site it is about. */
export const loader = methods({
  GET: async (request, { slug = "" }) => {
    const share = await getPublicShare(slug);
    if (share?.status !== "published")
      return errorResponse(request, 404, "share_not_found", "The public link was not found.");
    const name = share.snapshot.host.replace(/[^a-z0-9.-]/gi, "-");
    return pictureAnswer(await drawShareImage(share.snapshot), {
      "Content-Disposition": `attachment; filename="agentify-${name}.png"`,
    });
  },
});
export const action = loader;
