import type { RouterContextProvider } from "react-router";
import type { WooPages } from "../src/woo-pages.js";
import { services } from "./services.js";

/**
 * Every route of the WooCommerce connector says so in its `handle`, and where
 * the connector is not offered the mount takes it out of the build.
 */
export const WOOCOMMERCE = { woocommerce: true } as const;

/**
 * The connector's server half. A route that finds none was answered where the
 * connector is not offered, which the mount never does, so it is a defect.
 */
export const wooPagesIn = (context: Readonly<RouterContextProvider>): WooPages => {
  const woo = context.get(services).woo;
  if (woo === null) {
    throw new Error(
      "a WooCommerce page ran on a dashboard that does not offer the connector, where the mount" +
        " takes its routes out of the build — this is a defect in the mount",
    );
  }
  return woo;
};
