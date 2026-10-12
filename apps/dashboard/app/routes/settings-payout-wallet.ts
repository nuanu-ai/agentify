import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { formOf, sendTo } from "../answer.js";
import { services, signedIn } from "../services.js";
import { press, pressed } from "../settings-press.js";

/**
 * Opened from history or the address bar after a refusal, the press's address
 * leads to the page its form lives on; after the press itself, the page is
 * drawn here.
 */
export function loader({ url, context }: LoaderFunctionArgs) {
  if (context.get(pressed) === null) {
    const { base } = context.get(services);
    throw sendTo(`${base}/settings`, url, base);
  }
  return null;
}

export async function action(asked: ActionFunctionArgs) {
  const { request, context } = asked;
  return press(
    await context
      .get(services)
      .settings.wallet(
        context.get(signedIn),
        await formOf(request),
        request.headers.get("cookie") ?? undefined,
      ),
    asked,
  );
}

/** The settings page around this route draws the press's answer. */
export default function Pressed() {
  return null;
}
