/**
 * The key list and the press that issues a key. The press is answered with the
 * page that shows the new key's secret, the only answer that ever carries it.
 * It goes to that press alone, which nothing caches, and React Router keeps it
 * in the page's memory, never in history: a reload, a return to it through
 * Back and Forward, and any later visit draw the list.
 */

import {
  type ActionFunctionArgs,
  createContext,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunction,
  useActionData,
  useLoaderData,
} from "react-router";
import { answer, formOf } from "../answer.js";
import { Frame } from "../components/frame.js";
import { KeysScreen, NewKeyScreen } from "../screens/keys.js";
import { services, signedIn } from "../services.js";

/**
 * Read afresh at every look: a key revoked a moment ago must not read as
 * working on the screen a merchant opens when a key has leaked.
 */
export const handle = { fresh: true };

/**
 * Set by the press. Where no script sent it, React Router loads the page's
 * data after the press in the same request, and a list that failed to load
 * there would draw a problem in place of the one showing of a key's secret;
 * the press's answer is the whole page, so the list is not read.
 */
const pressed = createContext(false);

export async function loader(asked: LoaderFunctionArgs) {
  const { url, context } = asked;
  if (context.get(pressed)) return null;
  return answer(
    await context.get(services).keys.list(context.get(signedIn), url.searchParams),
    asked,
  );
}

export async function action(asked: ActionFunctionArgs) {
  const { request, context } = asked;
  context.set(pressed, true);
  return answer(
    await context.get(services).keys.issue(context.get(signedIn), await formOf(request)),
    asked,
  );
}

/** Where script sent the press, the page is drawn from its answer alone as well. */
export const shouldRevalidate: ShouldRevalidateFunction = ({
  actionResult,
  defaultShouldRevalidate,
}) => actionResult === undefined && defaultShouldRevalidate;

export default function Keys() {
  const loaded = useLoaderData<typeof loader>();
  const view = useActionData<typeof action>() ?? loaded;
  if (view === null) {
    throw new Error("the keys page was loaded after a press and drawn without its answer");
  }
  return view.screen === "issued" ? (
    <Frame tab="keys" title="Your new key" frame={view.frame}>
      <NewKeyScreen view={view} />
    </Frame>
  ) : (
    <Frame tab="keys" title="API keys" frame={view.frame}>
      <KeysScreen view={view} />
    </Frame>
  );
}
