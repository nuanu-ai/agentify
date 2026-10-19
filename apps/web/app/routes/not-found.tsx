import { data, type MetaArgs } from "react-router";

import { NOT_FOUND_TITLE, NotFoundPage } from "../../components/not-found-page";
import { pageMeta, siteConfigOf } from "../../lib/page-meta";

/** Any address no other route takes, read or posted to. */
export const loader = () => data(null, { status: 404 });

export const action = loader;

export const meta = ({ matches }: MetaArgs) =>
  pageMeta(siteConfigOf(matches), { title: NOT_FOUND_TITLE, robots: "noindex" });

export default function NotFound() {
  return <NotFoundPage />;
}
