import { type LoaderFunctionArgs, redirectDocument } from "react-router";

import { UNKEPT_PAGE_CACHE } from "../../lib/server/answer-headers";

/**
 * The address the scanner's and the browser observer's user agents name,
 * which a site's owner follows to learn who read their site: the page about
 * the scanner is in the documentation's Scanner section, and this address
 * leads there, whatever it is asked with, its query kept. Another process
 * serves the documentation, so a browser this router answers is sent there
 * to load it whole. Nobody keeps the redirect, so the documentation can move
 * it again.
 */
export const loader = ({ request }: LoaderFunctionArgs) => {
  throw redirectDocument(`/docs/scanner${new URL(request.url).search}`, {
    status: 308,
    headers: { "Cache-Control": UNKEPT_PAGE_CACHE },
  });
};

export const action = loader;
