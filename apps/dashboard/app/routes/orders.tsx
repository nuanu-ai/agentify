import {
  type ActionFunctionArgs,
  createContext,
  type LoaderFunctionArgs,
  useActionData,
  useLoaderData,
} from "react-router";
import { acted, formOf, readOnly } from "../answer.js";
import { Frame } from "../components/frame.js";
import { readFailedIn } from "../components/not-loaded.js";
import { OrdersScreen } from "../screens/orders.js";
import { services, signedIn } from "../services.js";

/**
 * Set by the press. Where no script sent it, React Router loads the page's
 * data after the press in the same request; the press's answer is the whole
 * page, read by the press itself, and a second read that failed would draw
 * its failure in place of what became of the press.
 */
const pressed = createContext(false);

export async function loader(asked: LoaderFunctionArgs) {
  const { url, context } = asked;
  if (context.get(pressed)) return null;
  return readOnly(
    async () => await context.get(services).screens.orders(context.get(signedIn), url.searchParams),
    asked,
  );
}

export async function action(asked: ActionFunctionArgs) {
  const { context, request } = asked;
  context.set(pressed, true);
  return acted(
    async () =>
      await context.get(services).fulfillment.close(context.get(signedIn), await formOf(request)),
    asked,
  );
}

export default function Orders() {
  const loaded = useLoaderData<typeof loader>();
  const view = useActionData<typeof action>() ?? loaded;
  if (view === null) {
    throw new Error("the orders page was loaded after a press and drawn without its answer");
  }
  return (
    <Frame tab="orders" title="Orders">
      <OrdersScreen view={view} />
    </Frame>
  );
}

export const ErrorBoundary = readFailedIn({ tab: "orders", title: "Orders", what: "orders" });
