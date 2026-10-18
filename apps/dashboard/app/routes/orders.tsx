import { type LoaderFunctionArgs, useLoaderData } from "react-router";
import { answer } from "../answer.js";
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

export default function Orders() {
  const view = useLoaderData<typeof loader>();
  return (
    <Frame tab="orders" title="Orders">
      <OrdersScreen view={view} />
    </Frame>
  );
}
