import { redirect } from "react-router";

import { UNKEPT_PAGE_CACHE } from "../../lib/server/answer-headers";

/**
 * The methodology is a page of the documentation's Scanner section, and links
 * already shared to it here reach it there, whatever they ask with. Nobody
 * keeps the redirect, so the documentation can move it again.
 */
export const loader = () => {
  throw redirect("/docs/scanner/methodology", {
    status: 308,
    headers: { "Cache-Control": UNKEPT_PAGE_CACHE },
  });
};

export const action = loader;
