import { pictureAnswer } from "../../lib/server/drawing";
import { methods } from "../../lib/server/methods";
import { sellToAgentsPicture } from "../../lib/server/site-pictures";

/** The card a link to the page about selling to agents unfurls into. */
export const loader = methods({ GET: async () => pictureAnswer(await sellToAgentsPicture()) });
export const action = loader;
