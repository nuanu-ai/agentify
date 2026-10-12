import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

/**
 * Every asset lives under the dashboard's prefix, so the edge's existing route
 * for it carries them, and every name carries a content hash, so the server can
 * let a browser keep them for a year.
 *
 * The shared components are one chunk. Left to the bundler, a component two
 * routes use becomes a chunk of its own that a route module imports, and a
 * click then fetches the route module first and only then discovers the chunk:
 * a second round trip on the way to the page. As one chunk, which the frame is
 * drawn from, every page has loaded it before any click.
 */
export default defineConfig({
  base: "/dashboard/",
  plugins: [reactRouter()],
  build: {
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks(id) {
          return /\/packages\/ui\/|\/app\/components\//.test(id) ? "components" : undefined;
        },
      },
    },
  },
});
