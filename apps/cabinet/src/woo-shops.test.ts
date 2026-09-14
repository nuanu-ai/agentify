/**
 * The store the offline suite runs on, held to the contract both stores keep.
 *
 * The Postgres one is held to the same list in `woo-shops.db-test.ts`, against
 * the tables the checked-in migration builds.
 */

import { wooShopsContract } from "./testing/woo-shops-contract.js";
import { memoryWooShops } from "./woo-shops.js";

wooShopsContract("in memory", async () => ({
  shops: memoryWooShops(),
  accounts: { one: "account-one", other: "account-two" },
  close: async () => {},
}));
