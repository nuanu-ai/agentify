import { pictureAnswer } from "../../lib/server/drawing";
import { methods } from "../../lib/server/methods";
import { sitePicture } from "../../lib/server/site-pictures";

/** The card a link to any page of the site unfurls into. */
export const loader = methods({ GET: async () => pictureAnswer(await sitePicture()) });
export const action = loader;
