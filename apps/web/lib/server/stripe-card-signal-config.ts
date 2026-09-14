import { z } from "zod";

const booleanEnv = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const optionalNonEmpty = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (value === "" ? undefined : value),
    schema.optional(),
  );

const stripeCardSignalEnv = z.object({
  CARD_SIGNAL_ENABLED: booleanEnv,
  STRIPE_ADAPTER: z.enum(["local", "stripe"]).default("local"),
  STRIPE_SECRET_KEY: optionalNonEmpty(z.string().min(1)),
  STRIPE_WEBHOOK_SECRET: optionalNonEmpty(z.string().min(1)),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: optionalNonEmpty(z.string().min(1)),
});

export type StripeCardSignalConfig = ReturnType<
  typeof getStripeCardSignalConfig
>;

export function getStripeCardSignalConfig() {
  const parsed = stripeCardSignalEnv.parse(process.env);
  const production = process.env.NODE_ENV === "production";
  if (parsed.CARD_SIGNAL_ENABLED && parsed.STRIPE_ADAPTER === "stripe") {
    if (!parsed.STRIPE_SECRET_KEY) throw new Error("stripe_secret_key_missing");
    if (!parsed.STRIPE_WEBHOOK_SECRET)
      throw new Error("stripe_webhook_secret_missing");
    if (!parsed.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY)
      throw new Error("stripe_publishable_key_missing");
  }
  if (
    production &&
    parsed.CARD_SIGNAL_ENABLED &&
    parsed.STRIPE_ADAPTER === "local"
  ) {
    throw new Error("local_stripe_adapter_forbidden_in_production");
  }
  return {
    ...parsed,
    production,
    webhookSecret:
      parsed.STRIPE_WEBHOOK_SECRET ??
      "local-stripe-webhook-secret-change-before-production",
  };
}

export function getCardSignalPublicConfig() {
  const config = getStripeCardSignalConfig();
  return {
    enabled: config.CARD_SIGNAL_ENABLED,
    adapter: config.STRIPE_ADAPTER,
    publishableKey: config.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? null,
  } as const;
}
