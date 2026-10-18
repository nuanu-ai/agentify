import { type ActionFunctionArgs, type LoaderFunctionArgs, useLoaderData } from "react-router";
import { acted, answer, formOf, useChrome } from "../answer.js";
import { Frame } from "../components/frame.js";
import { CardsScreen } from "../screens/cards.js";
import { services, signedIn } from "../services.js";

export async function loader(asked: LoaderFunctionArgs) {
  const { url, context } = asked;
  return answer(
    await context.get(services).screens.cards(context.get(signedIn), url.searchParams),
    asked,
  );
}

/**
 * The switches on the page, each naming itself in the address it posts to and
 * carrying the list it was pressed on.
 */
export async function action(asked: ActionFunctionArgs) {
  const { url, context, request } = asked;
  return acted(
    async () =>
      await context
        .get(services)
        .selling.press(context.get(signedIn), url.searchParams, await formOf(request)),
    asked,
  );
}

export default function Cards() {
  const view = useLoaderData<typeof loader>();
  return (
    <Frame tab="cards" title="Product cards" frame={view.frame}>
      <CardsScreen view={view} base={useChrome().base} />
    </Frame>
  );
}
