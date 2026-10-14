import { redirect } from "react-router";

import { UNKEPT_PAGE_CACHE } from "../../lib/server/answer-headers";

/**
 * The address the scanner's and the browser observer's user agents name,
 * which a site's owner follows to learn who read their site: the page about
 * the scanner is in the documentation's Scanner section, and this address
 * leads there, whatever it is asked with. Nobody keeps the redirect, so the
 * documentation can move it again.
 */
export const loader = () => {
  throw redirect("/docs/scanner", { status: 308, headers: { "Cache-Control": UNKEPT_PAGE_CACHE } });
};

export const action = loader;
