import type { RouterContextProvider } from "react-router";
import type { WooPages } from "../src/woo-pages.js";
import { services } from "./services.js";

/**
 * Every route of the WooCommerce connector says so in its `handle`, and a
 * dashboard given no shop store takes it out of the build at the mount.
 */
export const WOOCOMMERCE = { woocommerce: true } as const;

/**
 * The connector's server half. A route that finds none was answered by a
 * dashboard with no shop store, which the mount never does, so it is a defect.
 */
export const wooPagesIn = (context: Readonly<RouterContextProvider>): WooPages => {
  const woo = context.get(services).woo;
  if (woo === null) {
    throw new Error(
      "a WooCommerce page ran on a dashboard with no shop store, where the mount" +
        " takes its routes out of the build — this is a defect in the mount",
    );
  }
  return woo;
};
