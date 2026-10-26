/**
 * The WooCommerce connector's screen: connecting a shop, importing its
 * catalogue, and the way back to the merchant's own code.
 */

import { type LoaderFunctionArgs, useLoaderData } from "react-router";
import { answer } from "../answer.js";
import { readFailedIn } from "../components/not-loaded.js";
import { WooPage } from "../screens/woocommerce.js";
import { signedIn } from "../services.js";
import { WOOCOMMERCE, wooPagesIn } from "../woocommerce.js";

export const handle = WOOCOMMERCE;

export async function loader(asked: LoaderFunctionArgs) {
  const { url, context } = asked;
  return answer(await wooPagesIn(context).shop(context.get(signedIn), url.searchParams), asked);
}

export default function WooCommerce() {
  return <WooPage view={useLoaderData<typeof loader>()} />;
}

export const ErrorBoundary = readFailedIn({
  tab: "integrations",
  title: "WooCommerce",
  what: "WooCommerce settings",
});
