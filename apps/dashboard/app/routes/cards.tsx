import { type LoaderFunctionArgs, useLoaderData } from "react-router";
import { answer, useChrome } from "../answer.js";
import { Frame } from "../components/frame.js";
import { CardsScreen } from "../screens/cards.js";
import { services, signedIn } from "../services.js";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const pages = context.get(services);
  return answer(await pages.screens.cards(context.get(signedIn)), request, context);
}

export default function Cards() {
  const view = useLoaderData<typeof loader>();
  return (
    <Frame tab="cards" title="Product cards" frame={view.frame}>
      <CardsScreen view={view} base={useChrome().base} />
    </Frame>
  );
}
