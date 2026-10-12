/**
 * The merchant's door: a presented key is hashed (`keyDigest` in
 * `app/merchants.ts`) and its digest looked up (`Gateway#keyBehind`, the
 * store's `workingKey`). Never compare a key
 * against a secret with `===`; the time taken would leak how much of it was
 * right. A lookup by digest compares nothing secret.
 */

import { merchantKeyFrom } from "@nuanu-ai/agentify-contracts";

/**
 * The key inside the merchant-key header value, or nothing. The parse lives in
 * the contracts package so the gateway and the SDK cannot disagree on it.
 */
export const bearerIn = merchantKeyFrom;
