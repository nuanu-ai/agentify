import { pictureAnswer } from "../../lib/server/drawing";
import { methods } from "../../lib/server/methods";
import { appleIcon } from "../../lib/server/site-pictures";

/** The icon a phone keeps for the site on its home screen. */
export const loader = methods({ GET: async () => pictureAnswer(await appleIcon()) });
export const action = loader;
