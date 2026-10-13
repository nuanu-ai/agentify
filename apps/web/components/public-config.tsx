import { createContext, type ReactNode, useContext } from "react";

import type { PublicAppConfig } from "../lib/app-config";

const PublicConfig = createContext<PublicAppConfig | null>(null);

/**
 * The site's public settings, read from the environment by the root route's
 * loader on the server and handed to every component under it, in the browser
 * as on the server: a component that read the environment itself would find
 * none in the browser and draw something else there.
 */
export function PublicConfigProvider({
  config,
  children,
}: Readonly<{ config: PublicAppConfig; children: ReactNode }>) {
  return <PublicConfig.Provider value={config}>{children}</PublicConfig.Provider>;
}

export function usePublicConfig(): PublicAppConfig {
  const config = useContext(PublicConfig);
  if (config === null) {
    throw new Error("a component that needs the site's settings was drawn outside the root route");
  }
  return config;
}
