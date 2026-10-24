/** The press that admits a merchant to live sales, answered with the merchant's page in its new state. */

import { MerchantPressed, pressing, readsLeadToTheMerchant } from "./merchant-press.js";

export const middleware = readsLeadToTheMerchant;

export const action = pressing(() => ({ kind: "admit" }));

export default MerchantPressed;
