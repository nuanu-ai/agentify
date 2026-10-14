/** React Router's build, which its Vite plugin hands the server half of the build. */
declare module "virtual:react-router/server-build" {
  import type { ServerBuild } from "react-router";

  export const entry: ServerBuild["entry"];
  export const routes: ServerBuild["routes"];
  export const assets: ServerBuild["assets"];
  export const basename: ServerBuild["basename"];
  export const publicPath: ServerBuild["publicPath"];
  export const assetsBuildDirectory: ServerBuild["assetsBuildDirectory"];
  export const future: ServerBuild["future"];
  export const ssr: ServerBuild["ssr"];
  export const isSpaMode: ServerBuild["isSpaMode"];
  export const prerender: ServerBuild["prerender"];
  export const routeDiscovery: ServerBuild["routeDiscovery"];
  export const allowedActionOrigins: ServerBuild["allowedActionOrigins"];
}
