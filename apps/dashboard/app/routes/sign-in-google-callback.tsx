/**
 * Google's return opens a session only on a document GET. A page-data prefetch
 * or a HEAD must not spend a code, and a refusal carries no code into scripts.
 */

import { type LoaderFunctionArgs, useLoaderData } from "react-router";
import { answer, carried, useChrome } from "../answer.js";
import { AskScreen } from "../screens/sign-in.js";
import { services } from "../services.js";

export const handle = { script: false };
export const headers = carried;

export async function loader(asked: LoaderFunctionArgs) {
  const { request, url, context } = asked;
  if (request.method !== "GET" || new URL(request.url).pathname !== url.pathname) {
    throw new Response(null, { status: 405, headers: { Allow: "GET" } });
  }
  return answer(
    await context
      .get(services)
      .signIn.googleFinish(request.headers.get("cookie") ?? undefined, url.searchParams),
    asked,
  );
}

export default function GoogleCallback() {
  return <AskScreen chrome={useChrome()} view={useLoaderData<typeof loader>()} />;
}
