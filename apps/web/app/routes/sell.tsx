import { type MetaArgs, useLoaderData } from "react-router";

import { SellLandingPage } from "../../components/sell-landing";
import { SELL_LANDING } from "../../content/sell";

/**
 * The merchant landing. Its prices are a draft, so no cache keeps it past an
 * edit and no search engine lists it, and the live channel's edge answers its
 * address with the page that says there is none. A link to it is therefore a
 * plain anchor, so the edge, not the router, decides what a visitor sees.
 */
export const loader = () => SELL_LANDING;

export const headers = () => ({ "Cache-Control": "no-cache", "X-Robots-Tag": "noindex" });

export const meta = ({ loaderData }: MetaArgs<typeof loader>) =>
  loaderData === undefined
    ? []
    : [
        { title: loaderData.head.title },
        { name: "description", content: loaderData.head.description },
        { property: "og:type", content: "website" },
        { property: "og:title", content: loaderData.head.cardTitle },
        { property: "og:description", content: loaderData.head.cardDescription },
      ];

export default function SellPage() {
  return <SellLandingPage content={useLoaderData<typeof loader>()} />;
}
