/** The press that disables one of a merchant's keys, answered with the merchant's page in its new state. */

import { MerchantPressed, pressing, readsLeadToTheMerchant } from "./merchant-press.js";

export const middleware = readsLeadToTheMerchant;

export const action = pressing((params) => ({ kind: "disable_key", keyId: params.key_id ?? "" }));

export default MerchantPressed;
