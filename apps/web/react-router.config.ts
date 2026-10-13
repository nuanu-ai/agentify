import type { Config } from "@react-router/dev/config";

/**
 * The scanner's pages and its API, at the root of the origin. The build goes
 * to `dist`, which every ignore file already leaves out; its server half is
 * the whole process (`server/app.ts`), not only the pages.
 */
export default {
  appDirectory: "app",
  buildDirectory: "dist",
  ssr: true,
} satisfies Config;
