/**
 * The dashboard's pages a visitor with no session is shown rather than sent to
 * sign in, as their paths under the dashboard's prefix. `server.test.ts` holds
 * the server to this list, so a test that must know which pages stand in front
 * of the gate reads it here rather than working it out the way the code does.
 */
export const PAGES_IN_FRONT_OF_THE_GATE: readonly string[] = [
  "/sign-in",
  "/sign-in/open",
  "/woocommerce/return",
];
