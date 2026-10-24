/** The press that withdraws a merchant's admission with the note they read, answered with their page in its new state. */

import { MerchantPressed, pressing, readsLeadToTheMerchant } from "./merchant-press.js";

export const middleware = readsLeadToTheMerchant;

export const action = pressing(() => ({ kind: "withdraw" }));

export default MerchantPressed;
