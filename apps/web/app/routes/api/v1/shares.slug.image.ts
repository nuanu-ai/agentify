import { errorResponse } from "../../../../lib/server/http";
import { methods } from "../../../../lib/server/methods";
import { getPublicShare } from "../../../../lib/server/reporting";
import { sharePictureAnswer } from "../../../../lib/server/share-image";

/** A published share's card as a file to save, named after the site it is about. */
export const loader = methods({
  GET: async (request, { slug = "" }) => {
    const share = await getPublicShare(slug);
    if (share?.status !== "published")
      return errorResponse(request, 404, "share_not_found", "The public link was not found.");
    return sharePictureAnswer(request, share.snapshot);
  },
});
export const action = loader;
