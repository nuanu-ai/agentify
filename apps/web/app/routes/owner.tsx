import { redirect } from "react-router";

import { UNKEPT_PAGE_CACHE } from "../../lib/server/answer-headers";

/**
 * Links already shared to the owner landing reach the front page. Nobody
 * keeps the redirect: a browser holding one in either direction would loop.
 */
export const loader = () => {
  throw redirect("/", { status: 308, headers: { "Cache-Control": UNKEPT_PAGE_CACHE } });
};

export default function OwnerPage() {
  return null;
}
