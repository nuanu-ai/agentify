import { type MetaArgs, useLoaderData } from "react-router";

import { SellLandingPage } from "../../components/sell-landing";
import { SELL_LANDING } from "../../content/sell";

/**
 * The merchant landing. No cache keeps it past an edit, and no search engine
 * lists it.
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
