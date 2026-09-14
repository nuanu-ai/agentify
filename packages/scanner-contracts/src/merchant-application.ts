import { z } from "zod";

export const MERCHANT_APPLICATION_POLICY = "merchant-application-2026-09-09";
export const MERCHANT_APPLICATION_RETENTION_DAYS = 30;

export const merchantApplicationSchema = z.strictObject({
  businessName: z.string().trim().min(2).max(120),
  website: z
    .url({ protocol: /^https?$/ })
    .max(500)
    .refine((value) => {
      const url = new URL(value);
      return !url.username && !url.password;
    }),
  email: z
    .email()
    .max(254)
    .transform((value) => value.normalize("NFKC").toLowerCase()),
  category: z.enum([
    "retail",
    "hospitality",
    "food",
    "experiences",
    "services",
    "digital",
    "other",
  ]),
  country: z.string().trim().min(2).max(80),
  offer: z.string().trim().max(1200).default(""),
  consent: z.literal(true),
  companyFax: z.literal("").default(""),
});

export type MerchantApplication = z.infer<typeof merchantApplicationSchema>;
