import type { LoaderFunctionArgs, Params } from "react-router";

/**
 * What React Router hands a route's loader for a visit to `address`, for a
 * test that asks a loader directly where the whole process would need a
 * database it does not have.
 */
export const visitTo = (
  address: string,
  params: Params = {},
  headers: HeadersInit = {},
): LoaderFunctionArgs =>
  ({
    request: new Request(address, { headers }),
    url: new URL(address),
    pattern: "",
    params,
    context: {},
  }) as unknown as LoaderFunctionArgs;
