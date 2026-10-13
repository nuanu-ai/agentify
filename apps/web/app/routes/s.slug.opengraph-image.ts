import { pictureAnswer } from "../../lib/server/drawing";
import { methods } from "../../lib/server/methods";
import { getPublicShare } from "../../lib/server/reporting";
import { drawShareImage } from "../../lib/server/share-image";

/** The card a published share's page unfurls into; nothing for a share that is not published. */
export const loader = methods({
  GET: async (_request, { slug = "" }) => {
    const share = await getPublicShare(slug);
    if (share?.status !== "published") return new Response(null, { status: 404 });
    return pictureAnswer(await drawShareImage(share.snapshot));
  },
});
export const action = loader;
