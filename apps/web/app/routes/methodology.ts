import { type LoaderFunctionArgs, redirectDocument } from "react-router";

import { UNKEPT_PAGE_CACHE } from "../../lib/server/answer-headers";

/**
 * The methodology is a page of the documentation's Scanner section, and links
 * already shared to it here reach it there, whatever they ask with, their
 * query kept. Another process serves the documentation, so a browser this
 * router answers is sent there to load it whole. Nobody keeps the redirect,
 * so the documentation can move it again.
 */
export const loader = ({ request }: LoaderFunctionArgs) => {
  throw redirectDocument(`/docs/scanner/methodology${new URL(request.url).search}`, {
    status: 308,
    headers: { "Cache-Control": UNKEPT_PAGE_CACHE },
  });
};

export const action = loader;
