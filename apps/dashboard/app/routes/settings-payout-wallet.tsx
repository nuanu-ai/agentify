/**
 * The wallet's press. It stands beside the settings rather than inside them, so
 * a read of its address runs no loader of theirs and is sent on at once; after
 * the press it draws the page itself, from the read the press made.
 */

import { type ActionFunctionArgs, type LoaderFunctionArgs, useLoaderData } from "react-router";
import { formOf, readsLeadTo, sendTo } from "../answer.js";
import { Frame } from "../components/frame.js";
import { SettingsScreen } from "../screens/settings.js";
import { services, signedIn } from "../services.js";
import { press, pressed } from "../settings-press.js";

/** The page drawn here is the settings, which keep nothing. */
export const handle = { keepsData: false };

/**
 * A read of the address is sent on before any loader runs, the merchant's
 * pages' own layout among them, so it waits on nothing the gateway answers.
 */
export const middleware = readsLeadTo("/settings");

/**
 * Its data asked for with no press behind it leads to the page the press's
 * form lives on, as a read of the address does.
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
    async () =>
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
    <Frame tab="settings" title="Settings">
      <SettingsScreen view={view} />
    </Frame>
  );
}
