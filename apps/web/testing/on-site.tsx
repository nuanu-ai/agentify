/**
 * A component drawn the way the scanner's pages draw it: under the router, at
 * an address, with the site's settings the root route hands down (by default
 * those the test's environment gives). The router is real, so a test reads
 * where a press led from its location.
 */

import type { ReactElement } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { PublicConfigProvider } from "../components/public-config";
import { getPublicAppConfig, type PublicAppConfig } from "../lib/app-config";

type Options = Readonly<{ at?: string; config?: PublicAppConfig }>;

export function siteRouter(element: ReactElement, { at = "/", config }: Options = {}) {
  return createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <PublicConfigProvider config={config ?? getPublicAppConfig()}>
            {element}
          </PublicConfigProvider>
        ),
      },
    ],
    { initialEntries: [at] },
  );
}

export const onSite = (element: ReactElement, options: Options = {}) => (
  <RouterProvider router={siteRouter(element, options)} />
);
