import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  useActionData,
  useLoaderData,
} from "react-router";
import { acted, answer, formOf } from "../answer.js";
import { Frame } from "../components/frame.js";
import { OrdersScreen } from "../screens/orders.js";
import { services, signedIn } from "../services.js";

export async function loader(asked: LoaderFunctionArgs) {
  const { url, context } = asked;
  return answer(
    await context.get(services).screens.orders(context.get(signedIn), url.searchParams),
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
