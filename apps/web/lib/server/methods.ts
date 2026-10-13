import type { LoaderFunctionArgs, Params } from "react-router";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** What React Router hands a route, of which an API route reads the request and the path's parameters. */
type Asked = Pick<LoaderFunctionArgs, "request" | "params">;

/** What a method of an API route does with the request and the path's parameters. */
export type Handler = (request: Request, params: Params) => Response | Promise<Response>;

/**
 * An API route's `loader` and `action`, the one function for both, from the
 * methods it answers. The rest are answered as the scanner always has: a
 * `HEAD` as its `GET` without the body, an `OPTIONS` with `204` and the
 * methods in `Allow`, and any other method with an empty `405`.
 *
 *     export const loader = methods({ POST: consent });
 *     export const action = loader;
 */
export function methods(
  handlers: Partial<Record<Method, Handler>>,
): (args: Asked) => Promise<Response> {
  const named = Object.keys(handlers) as Method[];
  const allow = [...named, ...(named.includes("GET") ? ["HEAD"] : []), "OPTIONS"].sort().join(", ");
  return async ({ request, params }) => {
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: { allow } });
    const method = request.method === "HEAD" ? "GET" : (request.method as Method);
    const handler = handlers[method];
    return handler === undefined ? new Response(null, { status: 405 }) : handler(request, params);
  };
}
