/**
 * The settings, with the payout wallet. Each press on the page posts to an
 * address of its own, the routes nested here and the wallet's beside them, and
 * is answered with this page at that address or sent on. Its forms load the
 * next page whole, as a browser without script does: the page is drawn from
 * the read its press made, which only a press and its page answered in one
 * request share.
 */

import { type ActionFunctionArgs, type LoaderFunctionArgs, useLoaderData } from "react-router";
import { answer, formOf } from "../answer.js";
import { Frame } from "../components/frame.js";
import { SettingsScreen } from "../screens/settings.js";
import { services, signedIn } from "../services.js";
import { press, pressed } from "../settings-press.js";

export async function loader(asked: LoaderFunctionArgs) {
  const { context } = asked;
  return (
    context.get(pressed) ??
    answer(await context.get(services).settings.page(context.get(signedIn)), asked)
  );
}

export async function action(asked: ActionFunctionArgs) {
  const { request, context } = asked;
  return press(
    await context.get(services).settings.name(context.get(signedIn), await formOf(request)),
    asked,
  );
}

export default function Settings() {
  const view = useLoaderData<typeof loader>();
  return (
    <Frame tab="settings" title="Settings" frame={view.frame}>
      <SettingsScreen view={view} />
    </Frame>
  );
}
