import { type LoaderFunctionArgs, useLoaderData } from "react-router";
import { answer } from "../answer.js";
import { Frame } from "../components/frame.js";
import { OrdersScreen } from "../screens/orders.js";
import { services, signedIn } from "../services.js";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const pages = context.get(services);
  return answer(
    await pages.screens.orders(context.get(signedIn), new URL(request.url).searchParams),
    request,
    context,
  );
}

export default function Orders() {
  const view = useLoaderData<typeof loader>();
  return (
    <Frame tab="orders" title="Orders" frame={view.frame}>
      <OrdersScreen view={view} />
    </Frame>
  );
}
