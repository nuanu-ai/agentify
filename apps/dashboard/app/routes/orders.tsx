import {
  type ActionFunctionArgs,
  isRouteErrorResponse,
  type LoaderFunctionArgs,
  useActionData,
  useLoaderData,
  useRouteError,
} from "react-router";
import { acted, formOf, readOnly, type Trouble } from "../answer.js";
import { Frame } from "../components/frame.js";
import { ErrorBoundary as PageTrouble } from "../root.js";
import { OrdersNotLoaded, OrdersScreen } from "../screens/orders.js";
import { services, signedIn } from "../services.js";

export async function loader(asked: LoaderFunctionArgs) {
  const { url, context } = asked;
  return readOnly(
    async () => await context.get(services).screens.orders(context.get(signedIn), url.searchParams),
    asked,
  );
}

export async function action(asked: ActionFunctionArgs) {
  const { context, request } = asked;
  return acted(
    async () =>
      await context.get(services).fulfillment.close(context.get(signedIn), await formOf(request)),
    asked,
  );
}

export default function Orders() {
  const loaded = useLoaderData<typeof loader>();
  const view = useActionData<typeof action>() ?? loaded;
  return (
    <Frame tab="orders" title="Orders">
      <OrdersScreen view={view} />
    </Frame>
  );
}

/**
 * A read of the orders that failed changed nothing, so it is said in the
 * frame, the sections beside it, with the same list offered again. A press
 * that failed may have been done, and is the dashboard's own page about that.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const trouble = isRouteErrorResponse(error) ? (error.data as Trouble | undefined) : undefined;
  const again =
    trouble?.kind === "unread" || trouble?.kind === "problem" ? trouble.again : undefined;
  if (again === undefined) return <PageTrouble />;
  return (
    <Frame tab="orders" title="Orders">
      <OrdersNotLoaded again={again} />
    </Frame>
  );
}
