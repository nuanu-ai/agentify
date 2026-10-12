/**
 * The wallet's press. It stands beside the settings rather than inside them, so
 * a read of its address runs no loader of theirs and is sent on at once; after
 * the press it draws the page itself, from the read the press made.
 */

import { type ActionFunctionArgs, type LoaderFunctionArgs, useLoaderData } from "react-router";
import { formOf, sendTo } from "../answer.js";
import { Frame } from "../components/frame.js";
import { SettingsScreen } from "../screens/settings.js";
import { services, signedIn } from "../services.js";
import { press, pressed } from "../settings-press.js";

/** The page drawn here is the settings, which keep nothing. */
export const handle = { keepsData: false };

/**
 * Opened from history or the address bar after a refusal, the press's address
 * leads to the page its form lives on.
 */
export function loader({ url, context }: LoaderFunctionArgs) {
  const view = context.get(pressed);
  if (view === null) {
    const { base } = context.get(services);
    throw sendTo(`${base}/settings`, url, base);
  }
  return view;
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

export default function PayoutWalletPressed() {
  const view = useLoaderData<typeof loader>();
  return (
    <Frame tab="settings" title="Settings" frame={view.frame}>
      <SettingsScreen view={view} />
    </Frame>
  );
}
