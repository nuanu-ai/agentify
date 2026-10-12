import type { ActionFunctionArgs } from "react-router";
import { formOf } from "../answer.js";
import { services, signedIn } from "../services.js";
import { press, readsLeadToSettings } from "../settings-press.js";

export const middleware = readsLeadToSettings;

export async function action(asked: ActionFunctionArgs) {
  const { request, context } = asked;
  return press(
    await context
      .get(services)
      .settings.cancel(
        context.get(signedIn),
        await formOf(request),
        request.headers.get("cookie") ?? undefined,
      ),
    asked,
  );
}

/**
 * The settings page around this route draws the press's answer; a route with
 * no component of its own would answer the press with data rather than a page.
 */
export default function Pressed() {
  return null;
}
