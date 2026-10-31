import { MerchantPressed, pressing, readsLeadToTheMerchant } from "./merchant-press.js";

export const middleware = readsLeadToTheMerchant;
export const action = pressing(() => ({ kind: "decline" }));
export default MerchantPressed;
export { handle } from "./merchant.js";
