import { siteSchema } from "@agentify/ui";
import type { PublicAppConfig } from "./app-config";

/** The site and its operator as schema.org describes them, from the scanner's settings. */
export const publicSiteSchema = (config: PublicAppConfig): object =>
  siteSchema({
    brand: config.displayBrand,
    origin: new URL(config.baseUrl).origin,
    abuseEmail: config.abuseEmail,
  });
