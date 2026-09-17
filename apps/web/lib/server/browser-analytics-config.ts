import { z } from "zod";

const environment = z.enum(["local", "test", "preview", "production"]);
const optionalNonEmpty = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (value === "" ? undefined : value),
    schema.optional(),
  );

const schema = z.object({
  ANALYTICS_RUNTIME_ENV: environment.default("local"),
  POSTHOG_BROWSER_KEY: optionalNonEmpty(z.string().min(1)),
  POSTHOG_BROWSER_HOST: optionalNonEmpty(z.url({ protocol: /^https?$/ })),
  POSTHOG_DESTINATION_ENV: environment.default("local"),
  META_PIXEL_ID: optionalNonEmpty(z.string().min(1)),
  META_DESTINATION_ENV: environment.default("local"),
});

export function getBrowserAnalyticsConfig() {
  const parsed = schema.parse(process.env);
  if (
    Boolean(parsed.POSTHOG_BROWSER_KEY) !== Boolean(parsed.POSTHOG_BROWSER_HOST)
  )
    throw new Error("browser_posthog_requires_key_and_host");
  return {
    runtimeEnvironment: parsed.ANALYTICS_RUNTIME_ENV,
    posthog: {
      key: parsed.POSTHOG_BROWSER_KEY ?? null,
      host: parsed.POSTHOG_BROWSER_HOST ?? null,
      destinationEnvironment: parsed.POSTHOG_DESTINATION_ENV,
    },
    meta: {
      pixelId: parsed.META_PIXEL_ID ?? null,
      destinationEnvironment: parsed.META_DESTINATION_ENV,
    },
  } as const;
}
