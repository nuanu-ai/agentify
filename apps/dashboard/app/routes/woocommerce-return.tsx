/**
 * Where the shop sends the browser back to, in front of the gate: the server
 * half says why. It reads the session and nothing else, and the page it draws
 * for a browser without one is the same for everybody, with no script.
 */

import type { LoaderFunctionArgs } from "react-router";
import { answer, useChrome } from "../answer.js";
import { WooReturnScreen } from "../screens/woocommerce.js";
import { WOOCOMMERCE, wooPagesIn } from "../woocommerce.js";

export const handle = { ...WOOCOMMERCE, script: false };

export async function loader(asked: LoaderFunctionArgs) {
  const { request, url, context } = asked;
  return answer(
    await wooPagesIn(context).cameBack(
      request.headers.get("cookie") ?? undefined,
      url.searchParams,
    ),
    asked,
  );
}

export default function Return() {
  return <WooReturnScreen chrome={useChrome()} />;
}
