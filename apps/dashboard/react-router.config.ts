import type { Config } from "@react-router/dev/config";

/**
 * The dashboard's React pages. The prefix here is the deployed one; the server
 * that mounts the build hands it the prefix it is configured with, so a
 * dashboard run at the root of its origin answers there. The build goes to
 * `dist`, which every ignore file already leaves out.
 */
export default {
  appDirectory: "app",
  basename: "/dashboard",
  buildDirectory: "dist",
  ssr: true,
  future: { v8_middleware: true },
} satisfies Config;
