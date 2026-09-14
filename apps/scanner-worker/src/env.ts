import { z } from "zod";

const workerEnvSchema = z
  .object({
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    APP_BASE_URL: z.url({ protocol: /^https?$/ }),
    SCANNER_CACHE_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    SCANNER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(10),
    ANALYTICS_ENV: z
      .enum(["local", "test", "preview", "production"])
      .default("local"),
    POSTHOG_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    POSTHOG_DESTINATION_ENV: z
      .enum(["local", "test", "preview", "production"])
      .default("local"),
    POSTHOG_HOST: z
      .url({ protocol: /^https?$/ })
      .default("http://127.0.0.1:8000"),
    META_CAPI_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    META_DESTINATION_ENV: z
      .enum(["local", "test", "preview", "production"])
      .default("local"),
    META_GRAPH_BASE_URL: z
      .url({ protocol: /^https$/ })
      .default("https://graph.facebook.com"),
    META_API_VERSION: z
      .string()
      .regex(/^v\d+\.\d+$/)
      .default("v23.0"),
    META_DATASET_ID: z.string().default(""),
    META_ACCESS_TOKEN: z.string().default(""),
    PARTNER_POSTBACK_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    PARTNER_POSTBACK_SECRET: z.string().trim().default(""),
    WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(8081),
    WORKER_ID: z.string().trim().min(1).max(200).default("local-scanner-1"),
    APIFY_BROWSER_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    APIFY_BROWSER_MODE: z.enum(["off", "shadow", "report"]).default("off"),
    APIFY_API_TOKEN: z.string().default(""),
    APIFY_BROWSER_ACTOR_ID: z.string().trim().max(200).default(""),
    APIFY_BROWSER_ACTOR_BUILD: z.string().trim().max(200).default(""),
    APIFY_BROWSER_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
    APIFY_BROWSER_CONCURRENCY: z.coerce.number().int().min(1).max(5).default(1),
    APIFY_BROWSER_TIMEOUT_SECONDS: z.coerce
      .number()
      .int()
      .min(10)
      .max(120)
      .default(60),
    APIFY_BROWSER_MAX_RUN_USD: z.coerce
      .number()
      .positive()
      .max(1)
      .default(0.05),
    APIFY_BROWSER_DAILY_BUDGET_USD: z.coerce
      .number()
      .positive()
      .max(10_000)
      .default(25),
    APIFY_BROWSER_MAX_PAGES: z.coerce.number().int().min(1).max(3).default(3),
  })
  .superRefine((env, context) => {
    if (
      env.PARTNER_POSTBACK_ENABLED &&
      env.PARTNER_POSTBACK_SECRET.length < 16
    ) {
      context.addIssue({
        code: "custom",
        path: ["PARTNER_POSTBACK_SECRET"],
        message:
          "PARTNER_POSTBACK_SECRET is required when partner postback is active",
      });
    }
    const active =
      env.APIFY_BROWSER_ENABLED && env.APIFY_BROWSER_MODE !== "off";
    if (!active) return;
    for (const key of [
      "APIFY_API_TOKEN",
      "APIFY_BROWSER_ACTOR_ID",
      "APIFY_BROWSER_ACTOR_BUILD",
    ] as const) {
      if (!env[key]) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} is required when browser observation is active`,
        });
      }
    }
    if (/^(latest|beta|dev)$/i.test(env.APIFY_BROWSER_ACTOR_BUILD)) {
      context.addIssue({
        code: "custom",
        path: ["APIFY_BROWSER_ACTOR_BUILD"],
        message:
          "APIFY_BROWSER_ACTOR_BUILD must be an immutable build number/tag",
      });
    }
  });

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function readWorkerEnv(
  input: NodeJS.ProcessEnv = process.env,
): WorkerEnv {
  return workerEnvSchema.parse(input);
}
