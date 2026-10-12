/**
 * Signing out, in front of the gate so a tab whose session is gone can still
 * clear its cookie. It draws nothing and answers only the press.
 */

import type { ActionFunctionArgs } from "react-router";
import { answer } from "../answer.js";
import { services } from "../services.js";

export async function action(asked: ActionFunctionArgs) {
  const { request, context } = asked;
  return answer(
    await context.get(services).signIn.signOut(request.headers.get("cookie") ?? undefined),
    asked,
  );
}
